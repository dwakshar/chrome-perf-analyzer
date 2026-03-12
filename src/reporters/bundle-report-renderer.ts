// ─────────────────────────────────────────────────────────────────────────────
// bundle-report-renderer.ts
//
// Formats BundleAnalysisReport and ScriptRecord into human-readable text
// tables, ASCII size bars, and structured console output.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  BundleAnalysisReport,
  BundleIssue,
  IssueSeverity,
  ScriptRecord,
  ScriptSummary,
} from "../shared/types/bundle.types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Formatting utilities
// ─────────────────────────────────────────────────────────────────────────────

export function formatBytes(bytes: number | null, decimals = 1): string {
  if (bytes === null || bytes < 0) return "—";
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(decimals)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(decimals)} KB`;
  return `${bytes} B`;
}

export function formatPct(ratio: number | null): string {
  if (ratio === null) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

function pad(s: string | number, w: number, right = false): string {
  const str = String(s);
  return right ? str.padStart(w) : str.padEnd(w);
}

// ─────────────────────────────────────────────────────────────────────────────
// ASCII size bar (relative to largest bundle in report)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a proportional ASCII bar for a script's size.
 *
 *  ████████████████░░░░░  180 KB  (used: 62%)
 *  used ████, unused ░░░░
 */
export function renderSizeBar(
  parsedSize: number,
  unusedBytes: number | null,
  maxBytes: number,
  width = 24
): string {
  const ratio = maxBytes > 0 ? parsedSize / maxBytes : 0;
  const totalCols = Math.max(1, Math.round(ratio * width));

  if (unusedBytes !== null && parsedSize > 0) {
    const usedCols = Math.round((1 - unusedBytes / parsedSize) * totalCols);
    const unusedCols = totalCols - usedCols;
    return (
      "█".repeat(usedCols) +
      "░".repeat(unusedCols) +
      " ".repeat(width - totalCols)
    );
  }

  return "█".repeat(totalCols) + " ".repeat(width - totalCols);
}

// ─────────────────────────────────────────────────────────────────────────────
// Full text report
// ─────────────────────────────────────────────────────────────────────────────

export function renderBundleReport(report: BundleAnalysisReport): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);
  const sep = (w = 76) => lines.push("─".repeat(w));
  const hdr = (s: string) => {
    sep();
    line(` ${s}`);
    sep();
  };

  hdr("BUNDLE ANALYSIS REPORT");

  // ── Summary ───────────────────────────────────────────────────────────────
  line(` Page        : ${report.pageUrl || "—"}`);
  line(` Generated   : ${new Date(report.generatedAt).toISOString()}`);
  line(` Score       : ${renderScoreBadge(report.score)}  ${report.score}/100`);
  line();
  line(
    ` Scripts     : ${report.totalScripts} total  ·  ${report.externalScripts} external  ·  ${report.inlineScripts} inline  ·  ${report.moduleScripts} ES modules`
  );
  line();
  line(` Parsed JS   : ${formatBytes(report.totalParsedBytes)}`);
  line(` Transfer    : ${formatBytes(report.totalTransferBytes)}`);
  line(` Est. Gzip   : ${formatBytes(report.totalEstimatedGzip)}`);

  if (report.overallCoverageRatio !== null) {
    const used = formatBytes(report.totalUsedBytes);
    const unused = formatBytes(report.totalUnusedBytes);
    const pct = formatPct(1 - report.overallCoverageRatio);
    line(
      ` Coverage    : ${formatPct(
        report.overallCoverageRatio
      )} used  (${unused} unused, ${pct} waste)`
    );
  }

  line();

  // ── Score breakdown ───────────────────────────────────────────────────────
  const bd = report.scoreBreakdown;
  if (
    bd.sizePenalty ||
    bd.unusedPenalty ||
    bd.qualityPenalty ||
    bd.qualityBonus
  ) {
    hdr("SCORE BREAKDOWN");
    if (bd.sizePenalty) line(`  Size penalty    : -${bd.sizePenalty}`);
    if (bd.unusedPenalty) line(`  Unused penalty  : -${bd.unusedPenalty}`);
    if (bd.qualityPenalty) line(`  Quality penalty : -${bd.qualityPenalty}`);
    if (bd.qualityBonus) line(`  Quality bonus   : +${bd.qualityBonus}`);
    line();
  }

  // ── Detected libraries ────────────────────────────────────────────────────
  if (report.detectedLibraries.length > 0) {
    hdr("DETECTED LIBRARIES");

    const byCategory = groupBy(report.detectedLibraries, (l) => l.category);

    for (const [cat, libs] of Object.entries(byCategory)) {
      const names = libs
        .map((l) => (l.version ? `${l.name} v${l.version}` : l.name))
        .join(", ");
      line(`  ${pad(cat, 18)} ${names}`);
    }

    line();
  }

  // ── Largest bundles ───────────────────────────────────────────────────────
  if (report.largestBundles.length > 0) {
    hdr("LARGEST BUNDLES");
    renderSummaryTable(report.largestBundles, lines);
    line();
  }

  // ── Most unused ───────────────────────────────────────────────────────────
  if (report.mostUnused.length > 0) {
    hdr("MOST UNUSED CODE");
    renderSummaryTable(report.mostUnused, lines, "unused");
    line();
  }

  // ── Issues ────────────────────────────────────────────────────────────────
  if (report.allIssues.length > 0) {
    hdr(`ISSUES (${report.allIssues.length})`);
    renderIssuesTable(report.allIssues, lines);
  } else {
    hdr("ISSUES");
    line("  No issues detected. 🎉");
    line();
  }

  sep();
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary table (largest / most unused)
// ─────────────────────────────────────────────────────────────────────────────

function renderSummaryTable(
  summaries: ScriptSummary[],
  lines: string[],
  mode: "size" | "unused" = "size"
): void {
  if (summaries.length === 0) return;

  const maxBytes = Math.max(...summaries.map((s) => s.parsedSize ?? 0), 1);
  const colName = 26;

  const header = [
    pad("Script", colName),
    pad("Parsed", 10, true),
    pad("Gzip~", 8, true),
    pad("Coverage", 10, true),
    "  Bar",
  ].join("");

  lines.push(`  ${header}`);
  lines.push("  " + "─".repeat(74));

  for (const s of summaries) {
    const parsed = s.parsedSize ?? 0;
    const unused = s.unusedBytes;
    const coverage = s.coverageRatio;

    const bar = renderSizeBar(parsed, unused, maxBytes, 20);
    const name = truncate(s.scriptName, colName - 1);

    const row = [
      pad(name, colName),
      pad(formatBytes(parsed), 10, true),
      pad(formatBytes(parsed ? Math.round(parsed * 0.28) : null), 8, true),
      pad(coverage !== null ? formatPct(coverage) : "—", 10, true),
      `  ${bar}`,
    ].join("");

    lines.push(`  ${row}`);

    // Libraries on next line if any
    if (s.detectedLibraries.length > 0) {
      const libs = s.detectedLibraries.map((l) => l.name).join(", ");
      lines.push(`  ${pad("", colName)}  ↳ ${truncate(libs, 55)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Issues table
// ─────────────────────────────────────────────────────────────────────────────

function renderIssuesTable(issues: BundleIssue[], lines: string[]): void {
  const SEVERITY_BADGE: Record<IssueSeverity, string> = {
    critical: "CRIT",
    warning: "WARN",
    info: "INFO",
  };

  for (const issue of issues) {
    const badge = SEVERITY_BADGE[issue.severity];
    const savings = issue.savingsBytes
      ? `  [saves ~${formatBytes(issue.savingsBytes)}]`
      : "";

    lines.push(`  [${badge}] ${issue.title}${savings}`);
    lines.push(`         ${issue.detail}`);
    lines.push(`         → ${issue.recommendation}`);
    lines.push("");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Single script detail
// ─────────────────────────────────────────────────────────────────────────────

export function renderScriptDetail(script: ScriptRecord): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);
  const sep = () => lines.push("─".repeat(60));

  sep();
  line(` ${script.scriptName}`);
  sep();
  line(` URL          : ${truncate(script.url, 55)}`);
  line(` Script ID    : ${script.scriptId}`);
  line(` Origin       : ${script.origin}`);
  line(` Class        : ${script.classification}`);
  line(` Module       : ${script.isModule ? "yes (ESM)" : "no"}`);
  line(` Bundler      : ${script.bundler ?? "—"}`);
  line(` Source Map   : ${script.sourceMapUrl ? "✓ present" : "✗ absent"}`);
  line();
  line(` Parsed size  : ${formatBytes(script.parsedSize)}`);
  line(` Transfer     : ${formatBytes(script.transferSize)}`);
  line(` Est. gzip    : ${formatBytes(script.estimatedGzip)}`);
  line(` Lines        : ${script.lineCount.toLocaleString()}`);

  if (script.coverageRatio !== null) {
    line();
    line(
      ` Used bytes   : ${formatBytes(script.usedBytes)}  (${formatPct(
        script.coverageRatio
      )})`
    );
    line(` Unused bytes : ${formatBytes(script.unusedBytes)}`);

    const bar = renderSizeBar(
      script.parsedSize ?? 0,
      script.unusedBytes,
      script.parsedSize ?? 1,
      30
    );
    line(` Coverage bar : [${bar}]`);
    line(`               █ used  ░ unused`);
  }

  if (script.detectedLibraries.length > 0) {
    line();
    line(" Libraries:");
    for (const lib of script.detectedLibraries) {
      const ver = lib.version ? ` v${lib.version}` : "";
      const size = lib.estimatedSize
        ? `  ~${formatBytes(lib.estimatedSize)}`
        : "";
      line(`   • ${lib.name}${ver}  [${lib.category}]${size}`);
    }
  }

  if (script.issues.length > 0) {
    line();
    line(" Issues:");
    for (const issue of script.issues) {
      line(`   [${issue.severity.toUpperCase()}] ${issue.title}`);
      line(`          ${issue.recommendation}`);
    }
  }

  sep();
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Score badge
// ─────────────────────────────────────────────────────────────────────────────

function renderScoreBadge(score: number): string {
  if (score >= 90) return "🟢";
  if (score >= 70) return "🟡";
  if (score >= 50) return "🟠";
  return "🔴";
}

// ─────────────────────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON export
// ─────────────────────────────────────────────────────────────────────────────

export function reportToJSON(report: BundleAnalysisReport): string {
  return JSON.stringify(report, null, 2);
}
