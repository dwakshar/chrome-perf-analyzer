// ─────────────────────────────────────────────────────────────────────────────
// report-renderer.ts
//
// Converts a TimingReport into human-readable plain-text tables and
// structured console output, suitable for display in the DevTools panel
// or logging from the service worker.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  NetworkRequest,
  RequestTimingBreakdown,
  SlowRequest,
  TimingReport,
} from "../shared/types/network.types.js";

import {
  formatBytes,
  formatDuration,
  truncateUrl,
} from "../analyzers/timing-calculator.js";

// ─────────────────────────────────────────────────────────────────────────────
// Text report
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a full timing report as an ASCII table string.
 * Useful for copying into a text file or displaying in a <pre> element.
 */
export function renderTextReport(report: TimingReport): string {
  const lines: string[] = [];

  const line = (s = "") => lines.push(s);
  const sep = (w = 72) => lines.push("─".repeat(w));
  const hdr = (s: string) => {
    sep();
    line(` ${s}`);
    sep();
  };

  hdr("NETWORK TIMING REPORT");

  // ── Summary ───────────────────────────────────────────────────────────────
  line(` Generated : ${new Date(report.generatedAt).toISOString()}`);
  line(
    ` Requests  : ${report.totalRequests} total  ·  ${report.completedRequests} complete  ·  ${report.failedRequests} failed  ·  ${report.pendingRequests} pending`
  );
  line();

  // ── Aggregates ────────────────────────────────────────────────────────────
  hdr("AGGREGATE TIMING (completed requests)");

  const a = report.aggregates;
  const statRows: [string, string][] = [
    ["Min", formatDuration(a.min)],
    ["Mean", formatDuration(a.mean)],
    ["Median", formatDuration(a.median)],
    ["P75", formatDuration(a.p75)],
    ["P95", formatDuration(a.p95)],
    ["P99", formatDuration(a.p99)],
    ["Max", formatDuration(a.max)],
    ["Total", formatDuration(a.total)],
  ];

  for (const [label, value] of statRows) {
    line(` ${label.padEnd(10)} ${value}`);
  }

  line();

  // ── By resource type ──────────────────────────────────────────────────────
  hdr("BY RESOURCE TYPE");

  const typeHeader = `  ${"Type".padEnd(16)} ${"Requests".padStart(
    8
  )} ${"Mean".padStart(10)} ${"Max".padStart(10)} ${"Total Bytes".padStart(
    14
  )}`;
  line(typeHeader);
  line("  " + "─".repeat(62));

  const typeEntries = Object.entries(report.byType).sort(
    ([, a], [, b]) => b.totalBytes - a.totalBytes
  );

  for (const [type, bucket] of typeEntries) {
    const row = [
      type.padEnd(16),
      String(bucket.count).padStart(8),
      formatDuration(bucket.meanDuration).padStart(10),
      formatDuration(bucket.maxDuration).padStart(10),
      formatBytes(bucket.totalBytes).padStart(14),
    ].join(" ");
    line(`  ${row}`);
  }

  line();

  // ── Slowest requests ──────────────────────────────────────────────────────
  if (report.slowest.length > 0) {
    hdr(`SLOWEST REQUESTS (top ${report.slowest.length})`);
    renderSlowTable(report.slowest, lines);
    line();
  }

  // ── Bottlenecks ───────────────────────────────────────────────────────────
  if (report.bottlenecks.length > 0) {
    hdr(`BOTTLENECKS (${report.bottlenecks.length} requests flagged)`);
    renderSlowTable(report.bottlenecks, lines);
    line();
  } else {
    line(" No bottlenecks detected.");
    line();
  }

  sep();
  return lines.join("\n");
}

function renderSlowTable(requests: SlowRequest[], lines: string[]): void {
  const colW = { dur: 10, status: 7, type: 14, url: 36 };
  const header = `  ${"Duration".padStart(colW.dur)} ${"Status".padStart(
    colW.status
  )} ${"Type".padEnd(colW.type)} URL`;
  lines.push(header);
  lines.push("  " + "─".repeat(72));

  for (const req of requests) {
    const row = [
      formatDuration(req.duration).padStart(colW.dur),
      (req.statusCode !== null ? String(req.statusCode) : "—").padStart(
        colW.status
      ),
      req.resourceType.padEnd(colW.type),
      truncateUrl(req.url, colW.url),
    ].join(" ");
    lines.push(`  ${row}`);

    // Phase breakdown if available
    if (req.timing) {
      lines.push(renderTimingBar(req.timing, 60));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Waterfall bar rendering (ASCII)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a compact ASCII waterfall bar for a single request's timing phases.
 *
 * Example output:
 *   [··ddd====WWWWWWWWWWWW>>>>>>>]   dns:3ms  wait:24ms  recv:14ms
 */
export function renderTimingBar(
  timing: RequestTimingBreakdown,
  width = 50
): string {
  const total = timing.total || 1;

  const phases: Array<{
    key: keyof RequestTimingBreakdown;
    char: string;
    label: string;
  }> = [
    { key: "blocked", char: "·", label: "blk" },
    { key: "dns", char: "d", label: "dns" },
    { key: "connect", char: "=", label: "conn" },
    { key: "ssl", char: "s", label: "ssl" },
    { key: "send", char: ">", label: "send" },
    { key: "wait", char: "W", label: "wait" },
    { key: "receive", char: "<", label: "recv" },
  ];

  let bar = "  [";
  const labels: string[] = [];

  for (const phase of phases) {
    const dur = timing[phase.key] as number | null;
    if (dur === null || dur <= 0) continue;

    const chars = Math.max(1, Math.round((dur / total) * width));
    bar += phase.char.repeat(chars);

    if (dur >= 1) {
      labels.push(`${phase.label}:${formatDuration(dur)}`);
    }
  }

  bar += "]";

  const labelStr = labels.join("  ");
  return `${bar.padEnd(width + 4)}  ${labelStr}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-request detail
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a detailed view of a single NetworkRequest.
 */
export function renderRequestDetail(req: NetworkRequest): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);
  const sep = () => line("─".repeat(60));

  sep();
  line(` ${req.method}  ${truncateUrl(req.url, 52)}`);
  sep();

  line(` Status      : ${req.statusCode ?? "—"}  ${req.statusText ?? ""}`);
  line(` Type        : ${req.resourceType}`);
  line(` Protocol    : ${req.protocol ?? "—"}`);
  line(` From cache  : ${req.fromCache ? "yes" : "no"}`);
  line(` SW handled  : ${req.fromServiceWorker ? "yes" : "no"}`);
  line(` Body size   : ${formatBytes(req.encodedBodySize)}`);
  line(` Duration    : ${formatDuration(req.duration)}`);
  line(
    ` Start       : ${
      req.startTime ? new Date(req.startTime).toISOString() : "—"
    }`
  );

  if (req.timing) {
    line();
    line(" Phase breakdown:");
    const t = req.timing;
    const phases: Array<[string, number | null]> = [
      ["  Blocked", t.blocked],
      ["  DNS", t.dns],
      ["  Connect", t.connect],
      ["  SSL/TLS", t.ssl],
      ["  Send", t.send],
      ["  Wait (TTFB)", t.wait],
      ["  Receive", t.receive],
      ["  Total", t.total],
    ];
    for (const [label, val] of phases) {
      if (val !== null) line(`${label.padEnd(18)}: ${formatDuration(val)}`);
    }
    line();
    line(renderTimingBar(req.timing));
  }

  if (req.error) {
    line();
    line(` ERROR: ${req.error.text}`);
    if (req.error.blockedReason) line(` Blocked: ${req.error.blockedReason}`);
  }

  sep();
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON export
// ─────────────────────────────────────────────────────────────────────────────

/** Serialize a report to a pretty-printed JSON string. */
export function reportToJSON(report: TimingReport): string {
  return JSON.stringify(report, null, 2);
}

/** Serialize a single NetworkRequest to JSON. */
export function requestToJSON(req: NetworkRequest): string {
  return JSON.stringify(req, null, 2);
}
