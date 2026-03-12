// ─────────────────────────────────────────────────────────────────────────────
// script-classifier.ts
//
// Pure functions for classifying script records and generating actionable
// BundleIssues based on size, coverage, minification, and library signals.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  BundleAnalyzerConfig,
  BundleClassification,
  BundleIssue,
  ScoreBreakdown,
  ScriptOrigin,
  ScriptRecord,
} from "../shared/types/bundle.types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify a script based on its URL and origin.
 */
export function classifyScript(
  url: string,
  origin: ScriptOrigin,
  isModule: boolean
): BundleClassification {
  if (!url || url === "about:blank") return "inline-script";
  if (url.startsWith("chrome-extension://")) return "unknown";
  if (url.startsWith("data:")) return "unknown";

  // Eval and inline
  if (origin === "eval") return "eval-script";
  if (origin === "inline") return "inline-script";

  const lower = url.toLowerCase();

  // Service/web workers
  if (/service[-_]?worker/i.test(lower)) return "service-worker";
  if (/\bworker\b/i.test(lower) && !/framework|network/i.test(lower))
    return "worker";

  // Vendor / node_modules bundles
  if (/node_modules|\/vendor\/|\/vendors\//i.test(lower))
    return "vendor-bundle";

  // Cross-origin = third party
  if (origin === "cross-origin") return "third-party-script";

  // Same-origin chunks (lazy-loaded code splitting)
  if (/\/chunks?\/|[._-]chunk[._-]|[._-]\d{4,}\.js$/i.test(lower))
    return "first-party-chunk";

  // Main entry bundles
  if (
    /\/(?:main|app|index|bundle)[.-]/i.test(lower) ||
    lower.endsWith("/bundle.js")
  ) {
    return "first-party-bundle";
  }

  return "first-party-bundle";
}

/**
 * Determine script origin relative to the page's origin.
 */
export function determineOrigin(
  scriptUrl: string,
  pageUrl: string
): ScriptOrigin {
  if (!scriptUrl) return "inline";
  if (scriptUrl.startsWith("data:")) return "data-url";
  if (scriptUrl.startsWith("chrome-extension://")) return "extension";

  // Eval scripts have synthetic URLs like "eval at ..." or VM IDs
  if (/^(eval|VM\d|<)/i.test(scriptUrl)) return "eval";

  // Check if it's an inline script (no real URL)
  if (!scriptUrl.startsWith("http://") && !scriptUrl.startsWith("https://")) {
    return "inline";
  }

  try {
    const scriptOrigin = new URL(scriptUrl).origin;
    const pageOrigin = new URL(pageUrl).origin;
    return scriptOrigin === pageOrigin ? "same-origin" : "cross-origin";
  } catch {
    return "inline";
  }
}

/**
 * Heuristically determine if a script appears to be minified.
 * Checks average line length — minified bundles are typically one long line.
 */
export function isLikelyMinified(source: string, sampleLines = 20): boolean {
  if (!source) return false;

  const lines = source.split("\n").slice(0, sampleLines);
  if (lines.length === 0) return false;

  const avgLen = lines.reduce((s, l) => s + l.length, 0) / lines.length;
  return avgLen > 500; // Lines longer than 500 chars → likely minified
}

/**
 * Infer a human-readable script name from its URL.
 */
export function inferScriptName(url: string): string {
  if (!url) return "[inline]";
  if (url.startsWith("data:")) return "[data-uri]";

  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const filename = segments.at(-1) ?? u.host;

    // Strip hash suffixes like main.abc1234.js → main.js
    return filename.replace(/[.-][a-f0-9]{8,}\.(js|mjs)$/i, ".$1");
  } catch {
    return url.slice(-40);
  }
}

/**
 * Estimate Gzip-compressed size using a typical 0.28 compression ratio.
 * Real-world JS compresses to ~28–35% of raw size.
 */
export function estimateGzip(rawBytes: number): number {
  return Math.round(rawBytes * 0.28);
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue detection
// ─────────────────────────────────────────────────────────────────────────────

let issueCounter = 0;

function issueId(prefix: string): string {
  return `${prefix}_${++issueCounter}`;
}

/**
 * Generate all applicable BundleIssues for a single script.
 */
export function detectIssues(
  script: ScriptRecord,
  config: BundleAnalyzerConfig
): BundleIssue[] {
  const issues: BundleIssue[] = [];
  const size = script.parsedSize ?? script.transferSize ?? 0;

  // ── Issue: Large bundle ────────────────────────────────────────────────────
  if (size > config.largeBundleThresholdBytes) {
    const kb = (size / 1024).toFixed(0);
    const budgetKb = (config.largeBundleThresholdBytes / 1024).toFixed(0);
    const savings = size - config.largeBundleThresholdBytes;

    issues.push({
      id: issueId("large-bundle"),
      severity:
        size > config.largeBundleThresholdBytes * 3 ? "critical" : "warning",
      category: "size",
      title: `Large bundle detected (${kb} KB)`,
      detail: `"${script.scriptName}" is ${kb} KB parsed, exceeding the ${budgetKb} KB threshold.`,
      scriptId: script.scriptId,
      url: script.url,
      savingsBytes: savings,
      recommendation:
        "Use code splitting (dynamic import()) to split this bundle into smaller on-demand chunks.",
    });
  }

  // ── Issue: High unused code ────────────────────────────────────────────────
  if (
    script.coverageRatio !== null &&
    script.unusedBytes !== null &&
    script.coverageRatio < config.unusedCodeThreshold &&
    script.unusedBytes > 10_000 // Only flag if >10 KB unused (not noise)
  ) {
    const unusedKb = (script.unusedBytes / 1024).toFixed(0);
    const unusedPct = ((1 - script.coverageRatio) * 100).toFixed(0);

    issues.push({
      id: issueId("unused-code"),
      severity: script.coverageRatio < 0.3 ? "critical" : "warning",
      category: "unused-code",
      title: `${unusedPct}% unused code (${unusedKb} KB dead)`,
      detail: `Only ${(script.coverageRatio * 100).toFixed(0)}% of "${script.scriptName}" was executed during page load.`,
      scriptId: script.scriptId,
      url: script.url,
      savingsBytes: script.unusedBytes,
      recommendation:
        "Enable tree-shaking in your bundler and use dynamic import() for routes/features not needed on initial load.",
    });
  }

  // ── Issue: Large third-party script ───────────────────────────────────────
  if (
    script.classification === "third-party-script" &&
    size > 50_000 // >50 KB third-party
  ) {
    issues.push({
      id: issueId("third-party"),
      severity: size > 200_000 ? "critical" : "warning",
      category: "third-party",
      title: `Large third-party script (${(size / 1024).toFixed(0)} KB)`,
      detail: `"${script.scriptName}" is loaded from an external origin and cannot be tree-shaken.`,
      scriptId: script.scriptId,
      url: script.url,
      savingsBytes: size,
      recommendation:
        "Consider self-hosting this script, loading it asynchronously, or replacing with a lighter alternative.",
    });
  }

  // ── Issue: Missing source map ──────────────────────────────────────────────
  if (
    size > 50_000 &&
    !script.sourceMapUrl &&
    script.classification !== "third-party-script" &&
    script.classification !== "eval-script"
  ) {
    issues.push({
      id: issueId("no-source-map"),
      severity: "info",
      category: "source-map",
      title: "No source map detected",
      detail: `"${script.scriptName}" has no associated source map, making debugging difficult.`,
      scriptId: script.scriptId,
      url: script.url,
      recommendation:
        'Configure your bundler to emit source maps (sourcemap: true or devtool: "source-map").',
    });
  }

  // ── Issue: Testing library in production ──────────────────────────────────
  const testLibs = script.detectedLibraries.filter(
    (l) => l.category === "testing"
  );
  for (const lib of testLibs) {
    issues.push({
      id: issueId("test-in-prod"),
      severity: "critical",
      category: "size",
      title: `Testing library "${lib.name}" detected in production`,
      detail: `"${lib.name}" is a test-only dependency and should never ship to production users.`,
      scriptId: script.scriptId,
      url: script.url,
      recommendation:
        "Remove test dependencies from your production bundle. Check your bundler configuration and NODE_ENV handling.",
    });
  }

  return issues;
}

/**
 * Detect cross-script issues (duplicated libraries, total size budget).
 */
export function detectGlobalIssues(
  scripts: ScriptRecord[],
  config: BundleAnalyzerConfig
): BundleIssue[] {
  const issues: BundleIssue[] = [];

  // ── Total JS budget ────────────────────────────────────────────────────────
  const totalBytes = scripts.reduce((s, r) => s + (r.parsedSize ?? 0), 0);

  if (totalBytes > config.totalJsBudgetBytes) {
    const totalKb = (totalBytes / 1024).toFixed(0);
    const budgetKb = (config.totalJsBudgetBytes / 1024).toFixed(0);

    issues.push({
      id: issueId("total-budget"),
      severity:
        totalBytes > config.totalJsBudgetBytes * 2 ? "critical" : "warning",
      category: "size",
      title: `Total JS exceeds budget: ${totalKb} KB (budget: ${budgetKb} KB)`,
      detail: `The page loads ${totalKb} KB of JavaScript, which exceeds the recommended budget of ${budgetKb} KB.`,
      savingsBytes: totalBytes - config.totalJsBudgetBytes,
      recommendation:
        "Audit and remove unused dependencies, split the bundle, and defer non-critical scripts.",
    });
  }

  // ── Duplicate library detection ────────────────────────────────────────────
  const libOccurrences = new Map<
    string,
    { count: number; totalSize: number; urls: string[] }
  >();

  for (const script of scripts) {
    for (const lib of script.detectedLibraries) {
      const key = lib.name.toLowerCase();
      const current = libOccurrences.get(key) ?? {
        count: 0,
        totalSize: 0,
        urls: [],
      };
      current.count++;
      current.totalSize += lib.estimatedSize ?? 0;
      current.urls.push(script.scriptName);
      libOccurrences.set(key, current);
    }
  }

  for (const [name, info] of libOccurrences) {
    if (info.count > 1) {
      const wastedKb = ((info.totalSize * (info.count - 1)) / 1024).toFixed(0);

      issues.push({
        id: issueId("duplicate-lib"),
        severity: "warning",
        category: "duplication",
        title: `"${name}" loaded ${info.count} times`,
        detail: `Multiple bundles include a copy of "${name}": ${info.urls.slice(0, 3).join(", ")}.`,
        savingsBytes: info.totalSize * (info.count - 1),
        recommendation: `Deduplicate "${name}" using your bundler's deduplication plugin or by ensuring a single shared entry point.`,
      });
    }
  }

  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a 0–100 performance score for the JS payload of the page.
 * Higher is better.
 */
export function computeBundleScore(
  scripts: ScriptRecord[],
  totalBytes: number,
  config: BundleAnalyzerConfig
): { score: number; breakdown: ScoreBreakdown } {
  let score = 100;
  const breakdown: ScoreBreakdown = {
    sizePenalty: 0,
    unusedPenalty: 0,
    qualityPenalty: 0,
    qualityBonus: 0,
  };

  // ── Size penalty (0–40 points) ─────────────────────────────────────────────
  if (totalBytes > config.totalJsBudgetBytes) {
    const overRatio = Math.min(
      (totalBytes - config.totalJsBudgetBytes) / config.totalJsBudgetBytes,
      2
    );
    breakdown.sizePenalty = Math.round(overRatio * 40);
    score -= breakdown.sizePenalty;
  }

  // ── Unused code penalty (0–30 points) ─────────────────────────────────────
  const measuredScripts = scripts.filter((s) => s.coverageRatio !== null);

  if (measuredScripts.length > 0) {
    const totalMeasured = measuredScripts.reduce(
      (s, r) => s + (r.parsedSize ?? 0),
      0
    );
    const totalUnused = measuredScripts.reduce(
      (s, r) => s + (r.unusedBytes ?? 0),
      0
    );
    const unusedRatio = totalMeasured > 0 ? totalUnused / totalMeasured : 0;

    if (unusedRatio > 0.3) {
      breakdown.unusedPenalty = Math.round(
        Math.min((unusedRatio - 0.3) / 0.7, 1) * 30
      );
      score -= breakdown.unusedPenalty;
    }
  }

  // ── Quality penalties ──────────────────────────────────────────────────────
  const hasTestLibs = scripts.some((s) =>
    s.detectedLibraries.some((l) => l.category === "testing")
  );
  const hasMoment = scripts.some((s) =>
    s.detectedLibraries.some((l) => l.name === "Moment.js")
  );

  if (hasTestLibs) {
    breakdown.qualityPenalty += 15;
    score -= 15;
  }
  if (hasMoment) {
    breakdown.qualityPenalty += 5;
    score -= 5;
  }

  // ── Quality bonuses ────────────────────────────────────────────────────────
  const sourceMappedLargeScripts = scripts.filter(
    (s) => (s.parsedSize ?? 0) > 50_000 && s.sourceMapUrl
  ).length;
  const totalLargeScripts = scripts.filter(
    (s) => (s.parsedSize ?? 0) > 50_000
  ).length;

  if (totalLargeScripts > 0) {
    const mapRatio = sourceMappedLargeScripts / totalLargeScripts;
    breakdown.qualityBonus = Math.round(mapRatio * 5);
    score += breakdown.qualityBonus;
  }

  return { score: Math.max(0, Math.min(100, score)), breakdown };
}
