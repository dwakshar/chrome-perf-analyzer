// ─────────────────────────────────────────────────────────────────────────────
// bundle.types.ts
//
// All type definitions for the JavaScript bundle analyzer module.
// Covers raw CDP payloads, derived script records, and analysis outputs.
// ─────────────────────────────────────────────────────────────────────────────

// ── CDP Raw Payloads ──────────────────────────────────────────────────────────

/** Emitted by Debugger.scriptParsed when a script is parsed by V8 */
export interface CDPScriptParsed {
  scriptId: string;
  url: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  executionContextId: number;
  hash: string;
  executionContextAuxData?: Record<string, unknown>;
  isLiveEdit?: boolean;
  sourceMapURL?: string;
  hasSourceURL?: boolean;
  isModule?: boolean;
  length?: number; // Script length in bytes (V8 provided)
  stackTrace?: CDPStackTrace;
}

/** Emitted by CSS.styleSheetAdded (included for completeness) */
export interface CDPScriptFailedToParse {
  scriptId: string;
  url: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  executionContextId: number;
  hash: string;
  errorLine: number;
  errorMessage: string;
}

/** Response shape from Debugger.getScriptSource */
export interface CDPGetScriptSourceResponse {
  scriptSource: string;
  bytecode?: string; // Base64-encoded bytecode (if available)
}

/** Response shape from Profiler.takePreciseCoverage */
export interface CDPCoverageResult {
  result: CDPScriptCoverage[];
}

export interface CDPScriptCoverage {
  scriptId: string;
  url: string;
  functions: CDPFunctionCoverage[];
}

export interface CDPFunctionCoverage {
  functionName: string;
  ranges: CDPCoverageRange[];
  isBlockCoverage: boolean;
}

export interface CDPCoverageRange {
  startOffset: number;
  endOffset: number;
  count: number;
}

export interface CDPStackTrace {
  description?: string;
  callFrames: CDPCallFrame[];
  parent?: CDPStackTrace;
}

export interface CDPCallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

// ── Core Script Record ────────────────────────────────────────────────────────

/**
 * Fully enriched record for a single parsed JavaScript resource.
 */
export interface ScriptRecord {
  // ── Identity ──────────────────────────────────────────────────────────────
  scriptId: string;
  url: string;
  /** Inferred from URL or heuristic analysis */
  scriptName: string;
  /** Origin of this script (same-origin, cross-origin, inline, eval) */
  origin: ScriptOrigin;
  /** Whether this is an ES module */
  isModule: boolean;
  /** URL to the associated source map, if any */
  sourceMapUrl: string | null;

  // ── Size metrics ──────────────────────────────────────────────────────────
  /** Raw byte size reported by V8 at parse time */
  parsedSize: number | null;
  /** Actual transferred bytes (from Network domain, if correlated) */
  transferSize: number | null;
  /** Gzip-estimated size (heuristic: parsedSize * 0.3) */
  estimatedGzip: number | null;
  /** Number of source lines */
  lineCount: number;

  // ── Coverage ──────────────────────────────────────────────────────────────
  /** Bytes of this script that were actually executed */
  usedBytes: number | null;
  /** Bytes that were parsed but never executed */
  unusedBytes: number | null;
  /** Coverage ratio 0–1 (usedBytes / parsedSize), null if unmeasured */
  coverageRatio: number | null;

  // ── Classification ────────────────────────────────────────────────────────
  classification: BundleClassification;
  /** Detected framework or library hints */
  detectedLibraries: DetectedLibrary[];
  /** Detected bundler that produced this script */
  bundler: DetectedBundler | null;

  // ── Timing ────────────────────────────────────────────────────────────────
  /** Wall-clock time when scriptParsed fired (ms since epoch) */
  parsedAt: number;
  /** V8 parse duration in ms (from Debugger metadata, if available) */
  parseDuration: number | null;

  // ── Issues ────────────────────────────────────────────────────────────────
  issues: BundleIssue[];
}

// ── Bundle Analysis ───────────────────────────────────────────────────────────

export interface BundleAnalysisReport {
  generatedAt: number;
  pageUrl: string;

  // ── Counts ────────────────────────────────────────────────────────────────
  totalScripts: number;
  inlineScripts: number;
  externalScripts: number;
  moduleScripts: number;

  // ── Size aggregates (bytes) ───────────────────────────────────────────────
  totalParsedBytes: number;
  totalTransferBytes: number;
  totalEstimatedGzip: number;
  totalUsedBytes: number;
  totalUnusedBytes: number;
  /** Weighted average coverage across all measured scripts */
  overallCoverageRatio: number | null;

  // ── Breakdowns ────────────────────────────────────────────────────────────
  byOrigin: Record<ScriptOrigin, OriginBucket>;
  largestBundles: ScriptSummary[];
  mostUnused: ScriptSummary[];
  allIssues: BundleIssue[];
  detectedLibraries: DetectedLibrary[];

  // ── Performance score (0–100) ─────────────────────────────────────────────
  score: number;
  scoreBreakdown: ScoreBreakdown;
}

export interface OriginBucket {
  count: number;
  totalBytes: number;
  unusedBytes: number;
  scriptIds: string[];
}

export interface ScriptSummary {
  scriptId: string;
  url: string;
  scriptName: string;
  parsedSize: number | null;
  transferSize: number | null;
  unusedBytes: number | null;
  coverageRatio: number | null;
  classification: BundleClassification;
  detectedLibraries: DetectedLibrary[];
  issueCount: number;
}

export interface ScoreBreakdown {
  /** Penalty for exceeding total JS budget */
  sizePenalty: number;
  /** Penalty for low overall coverage */
  unusedPenalty: number;
  /** Penalty for unminified / development builds */
  qualityPenalty: number;
  /** Bonus for source maps, tree-shaking indicators */
  qualityBonus: number;
}

// ── Issue System ──────────────────────────────────────────────────────────────

export interface BundleIssue {
  id: string;
  severity: IssueSeverity;
  category: IssueCategory;
  title: string;
  detail: string;
  scriptId?: string;
  url?: string;
  /** Estimated byte savings if issue is resolved */
  savingsBytes?: number;
  recommendation: string;
}

export type IssueSeverity = "critical" | "warning" | "info";
export type IssueCategory =
  | "size" // Bundle too large
  | "unused-code" // High proportion of dead code
  | "duplication" // Same library detected multiple times
  | "minification" // Unminified code detected
  | "source-map" // Missing or invalid source map
  | "module-format" // Non-module script that could be a module
  | "third-party"; // Large third-party dependency

// ── Classification ────────────────────────────────────────────────────────────

export type BundleClassification =
  | "first-party-bundle" // Main app bundle from same origin
  | "first-party-chunk" // Lazy-loaded chunk from same origin
  | "vendor-bundle" // node_modules / vendor code
  | "third-party-script" // External CDN / analytics
  | "inline-script" // Inline <script> tag
  | "eval-script" // eval() / new Function() result
  | "service-worker" // SW script
  | "worker" // Web worker
  | "unknown";

export type ScriptOrigin =
  | "same-origin"
  | "cross-origin"
  | "inline"
  | "eval"
  | "data-url"
  | "extension";

// ── Library Detection ─────────────────────────────────────────────────────────

export interface DetectedLibrary {
  name: string;
  version?: string;
  category: LibraryCategory;
  /** Approximate byte footprint of this library */
  estimatedSize?: number;
  isDuplicate?: boolean;
}

export type LibraryCategory =
  | "framework" // React, Vue, Angular, Svelte
  | "ui-library" // MUI, Ant Design, Chakra
  | "utility" // Lodash, Underscore, Ramda
  | "bundler-runtime" // Webpack runtime, Rollup IIFE wrapper
  | "polyfill" // core-js, regenerator-runtime
  | "analytics" // GA, Segment, Mixpanel
  | "testing" // Jest, Mocha (shouldn't be in prod)
  | "other";

export type DetectedBundler =
  | "webpack"
  | "rollup"
  | "parcel"
  | "esbuild"
  | "vite"
  | "turbopack"
  | "unknown";

// ── Config ────────────────────────────────────────────────────────────────────

export interface BundleAnalyzerConfig {
  /** Bytes above which a single script is flagged as large. Default: 200 KB */
  largeBundleThresholdBytes: number;
  /** Bytes above which total JS is flagged. Default: 1 MB */
  totalJsBudgetBytes: number;
  /** Coverage ratio below which unused-code issues are raised. Default: 0.5 */
  unusedCodeThreshold: number;
  /** Whether to fetch script source for deeper analysis. Default: false */
  fetchScriptSource: boolean;
  /** Whether to enable CDP Profiler coverage. Default: false */
  enableCoverage: boolean;
  /** URL patterns to exclude from analysis */
  excludePatterns: string[];
  /** Only analyze same-origin scripts */
  sameOriginOnly: boolean;
}

export interface BundleAnalyzerCallbacks {
  onScriptParsed?: (script: ScriptRecord) => void;
  onLargeBundle?: (script: ScriptRecord) => void;
  onReport?: (report: BundleAnalysisReport) => void;
}
