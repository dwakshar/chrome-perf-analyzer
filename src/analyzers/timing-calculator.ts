// ─────────────────────────────────────────────────────────────────────────────
// timing-calculator.ts
//
// Pure functions for deriving human-readable timing phases from raw CDP
// CDPResourceTiming offsets. All outputs are in milliseconds.
//
// CDP timing model (all offsets are ms relative to requestTime):
//
//   requestTime ──────────────────────────────────── (base, in seconds)
//     [blocked]  proxyStart → proxyEnd
//     [dns]      dnsStart   → dnsEnd
//     [connect]  connectStart → connectEnd
//     [ssl]      sslStart   → sslEnd        (subset of connect)
//     [send]     sendStart  → sendEnd
//     [wait]     sendEnd    → receiveHeadersEnd  (TTFB)
//     [receive]  receiveHeadersEnd → loadingFinished.timestamp
//
// ─────────────────────────────────────────────────────────────────────────────

import type {
  CDPResourceTiming,
  RequestTimingBreakdown,
} from "../shared/types/network.types.js";

/**
 * Convert a raw CDP resource timing object into a named phase breakdown.
 *
 * @param raw        The CDPResourceTiming from the response object
 * @param finishTime CDP monotonic timestamp (seconds) when loading finished
 * @returns          Per-phase durations in milliseconds
 */
export function computeTimingBreakdown(
  raw: CDPResourceTiming,
  finishTime: number
): RequestTimingBreakdown {
  const base = raw.requestTime * 1000; // Convert base to ms

  // A value of -1 means "not applicable" in CDP.
  const phase = (start: number, end: number): number | null =>
    start >= 0 && end >= 0 && end > start ? end - start : null;

  const dns = phase(raw.dnsStart, raw.dnsEnd);
  const ssl = phase(raw.sslStart, raw.sslEnd);
  const connect = phase(raw.connectStart, raw.connectEnd);

  // "Blocked" time: proxy stall or queue wait before DNS could start.
  // Use proxyStart if available, else fall back to the gap before dnsStart.
  const blockedEnd =
    raw.dnsStart >= 0
      ? raw.dnsStart
      : raw.connectStart >= 0
        ? raw.connectStart
        : raw.sendStart;

  const blocked =
    raw.proxyStart >= 0
      ? phase(raw.proxyStart, blockedEnd)
      : raw.proxyStart === -1 && blockedEnd > 0
        ? blockedEnd
        : null;

  const send = phase(raw.sendStart, raw.sendEnd);

  // TTFB: from end of send to receipt of response headers.
  const wait =
    raw.sendEnd >= 0 && raw.receiveHeadersEnd >= 0
      ? raw.receiveHeadersEnd - raw.sendEnd
      : null;

  // Receive: from headers end to loading finished.
  const receiveStartMs = base + raw.receiveHeadersEnd;
  const finishMs = finishTime * 1000;
  const receive =
    raw.receiveHeadersEnd >= 0 && finishMs > receiveStartMs
      ? finishMs - receiveStartMs
      : null;

  // Total: wall time from request send to finish.
  const total = finishMs - base;

  return { dns, connect, ssl, blocked, send, wait, receive, total };
}

/**
 * Compute total duration when full CDPResourceTiming isn't available
 * (e.g. cached responses, service worker responses).
 */
export function computeSimpleDuration(
  startWallTime: number,
  endTimestamp: number,
  requestTime: number
): number {
  // endTimestamp is a CDP monotonic time (seconds).
  // requestTime is also CDP monotonic (seconds).
  // Convert the delta to ms.
  return (endTimestamp - requestTime) * 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Statistics helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute descriptive statistics over an array of durations (ms).
 */
export function computeStats(durations: number[]): {
  min: number;
  max: number;
  mean: number;
  median: number;
  p75: number;
  p95: number;
  p99: number;
  total: number;
} {
  if (durations.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p75: 0,
      p95: 0,
      p99: 0,
      total: 0,
    };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((s, v) => s + v, 0);

  return {
    min: sorted[0]!,
    max: sorted[n - 1]!,
    mean: total / n,
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    total,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

/** Format a duration in ms for display (e.g. "1.23 s", "456 ms") */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 1) return `${ms.toFixed(0)} ms`;
  return `${ms.toFixed(2)} ms`;
}

/** Format bytes for display (e.g. "1.2 MB", "456 KB") */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes < 0) return "—";
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Truncate a URL to a readable length, preserving path end */
export function truncateUrl(url: string, maxLen = 60): string {
  if (url.length <= maxLen) return url;
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    const host = u.host;
    const avail = maxLen - host.length - 4;
    if (avail < 8) return url.slice(0, maxLen) + "…";
    return `${host}/…${path.slice(-avail)}`;
  } catch {
    return url.slice(0, maxLen) + "…";
  }
}
