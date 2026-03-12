// ─────────────────────────────────────────────────────────────────────────────
// bundle-analyzer.ts
//
// Core module. Subscribes to CDP Debugger.scriptParsed events and optionally
// correlates with Profiler coverage and Network transfer sizes to produce a
// fully enriched ScriptRecord for every JavaScript resource on the page.
//
// Usage (from the extension service worker):
//
//   const analyzer = new BundleAnalyzer(tabId, {
//     largeBundleThresholdBytes: 200_000,
//     enableCoverage: true,
//   }, {
//     onLargeBundle: (s) => console.warn('BIG:', s.scriptName, s.parsedSize),
//   });
//
//   await analyzer.attach();
//   // ...navigate or wait for page load...
//   const report = await analyzer.generateReport('https://example.com');
//   await analyzer.detach();
//
// ─────────────────────────────────────────────────────────────────────────────

import type {
  BundleAnalysisReport,
  BundleAnalyzerCallbacks,
  BundleAnalyzerConfig,
  CDPCoverageResult,
  CDPGetScriptSourceResponse,
  CDPScriptParsed,
  DetectedLibrary,
  OriginBucket,
  ScriptOrigin,
  ScriptRecord,
  ScriptSummary,
} from "../shared/types/bundle.types.js";

import {
  classifyScript,
  computeBundleScore,
  detectGlobalIssues,
  detectIssues,
  determineOrigin,
  estimateGzip,
  inferScriptName,
} from "../analyzers/script-classifier.js";

import {
  detectLibrariesFromSource,
  detectLibrariesFromUrl,
} from "../analyzers/library-fingerprints.js";

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: BundleAnalyzerConfig = {
  largeBundleThresholdBytes: 200_000, // 200 KB parsed
  totalJsBudgetBytes: 1_048_576, // 1 MB total
  unusedCodeThreshold: 0.5, // 50% usage minimum
  fetchScriptSource: false,
  enableCoverage: false,
  excludePatterns: [],
  sameOriginOnly: false,
};

// Scripts shorter than this are too small to analyse meaningfully
const MIN_ANALYSABLE_BYTES = 1_024; // 1 KB

// ─────────────────────────────────────────────────────────────────────────────
// BundleAnalyzer
// ─────────────────────────────────────────────────────────────────────────────

export class BundleAnalyzer {
  private readonly tabId: number;
  private readonly config: BundleAnalyzerConfig;
  private readonly callbacks: BundleAnalyzerCallbacks;

  /** scriptId → ScriptRecord */
  private readonly scripts = new Map<string, ScriptRecord>();

  /** scriptId → transfer bytes (correlated from Network events externally) */
  private readonly networkSizes = new Map<string, number>();

  private attached = false;
  private pageUrl = "";

  private readonly boundOnEvent = this.onCDPEvent.bind(this);
  private readonly boundOnDetach = this.onDebuggerDetach.bind(this);

  constructor(
    tabId: number,
    config?: Partial<BundleAnalyzerConfig>,
    callbacks?: BundleAnalyzerCallbacks
  ) {
    this.tabId = tabId;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.callbacks = callbacks ?? {};
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async attach(): Promise<void> {
    if (this.attached) return;

    // The debugger may already be attached by the NetworkCollector.
    // chrome.debugger.attach() throws if already attached — catch and proceed.
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, "1.3");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already attached")) throw err;
    }

    // Enable the Debugger domain (exposes scriptParsed events + getScriptSource)
    await this.sendCommand("Debugger.enable");

    // Optionally enable Profiler for precise coverage
    if (this.config.enableCoverage) {
      await this.sendCommand("Profiler.enable");
      await this.sendCommand("Profiler.startPreciseCoverage", {
        callCount: false,
        detailed: true,
        allowTriggeredUpdates: false,
      });
    }

    chrome.debugger.onEvent.addListener(this.boundOnEvent);
    chrome.debugger.onDetach.addListener(this.boundOnDetach);

    this.attached = true;
    console.info(`[BundleAnalyzer] Attached to tab ${this.tabId}`);
  }

  async detach(): Promise<void> {
    if (!this.attached) return;

    if (this.config.enableCoverage) {
      try {
        await this.sendCommand("Profiler.stopPreciseCoverage");
        await this.sendCommand("Profiler.disable");
      } catch {
        /* ignore */
      }
    }

    try {
      await this.sendCommand("Debugger.disable");
    } catch {
      /* ignore */
    }

    chrome.debugger.onEvent.removeListener(this.boundOnEvent);
    chrome.debugger.onDetach.removeListener(this.boundOnDetach);

    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch {
      /* tab may be closed */
    }

    this.attached = false;
    console.info(`[BundleAnalyzer] Detached from tab ${this.tabId}`);
  }

  clear(): void {
    this.scripts.clear();
    this.networkSizes.clear();
  }

  // ── External correlation ──────────────────────────────────────────────────

  /**
   * Accept Network-domain transfer sizes from the NetworkCollector.
   * Call this after Network.loadingFinished fires for script resources.
   */
  correlateNetworkSize(scriptUrl: string, transferBytes: number): void {
    // We index by URL because Network and Debugger use different IDs.
    for (const [id, script] of this.scripts) {
      if (script.url === scriptUrl) {
        this.scripts.set(id, { ...script, transferSize: transferBytes });
        return;
      }
    }
    // Store pending — script may not have been parsed yet
    this.networkSizes.set(scriptUrl, transferBytes);
  }

  // ── CDP routing ───────────────────────────────────────────────────────────

  private onCDPEvent(
    source: chrome.debugger.Debuggee,
    method: string,
    params?: unknown
  ): void {
    if (source.tabId !== this.tabId) return;

    if (method === "Debugger.scriptParsed") {
      this.handleScriptParsed(params as CDPScriptParsed);
    }
  }

  private onDebuggerDetach(source: chrome.debugger.Debuggee): void {
    if (source.tabId === this.tabId) {
      this.attached = false;
      console.warn(
        `[BundleAnalyzer] Debugger detached unexpectedly from tab ${this.tabId}`
      );
    }
  }

  // ── Script parsed handler ─────────────────────────────────────────────────

  private handleScriptParsed(event: CDPScriptParsed): void {
    const {
      scriptId,
      url,
      length,
      sourceMapURL,
      isModule,
      startLine,
      endLine,
    } = event;

    // Skip empty/chrome-internal scripts
    if (!url && !length) return;
    if (url.startsWith("chrome-extension://")) return;
    if (url.startsWith("chrome://")) return;

    // Apply exclusion filters
    if (this.shouldExclude(url)) return;

    const parsedSize = length ?? null;

    // Skip trivially small scripts
    if (parsedSize !== null && parsedSize < MIN_ANALYSABLE_BYTES) return;

    const origin = determineOrigin(url, this.pageUrl);
    const classification = classifyScript(url, origin, !!isModule);

    // Same-origin filter
    if (
      this.config.sameOriginOnly &&
      origin !== "same-origin" &&
      origin !== "inline"
    )
      return;

    const scriptName = inferScriptName(url);
    const libsFromUrl = detectLibrariesFromUrl(url);
    const pendingTransfer = this.networkSizes.get(url) ?? null;

    const record: ScriptRecord = {
      scriptId,
      url,
      scriptName,
      origin,
      isModule: !!isModule,
      sourceMapUrl: sourceMapURL || null,

      parsedSize,
      transferSize: pendingTransfer,
      estimatedGzip: parsedSize !== null ? estimateGzip(parsedSize) : null,
      lineCount: endLine - startLine + 1,

      usedBytes: null,
      unusedBytes: null,
      coverageRatio: null,

      classification,
      detectedLibraries: libsFromUrl,
      bundler: null,

      parsedAt: Date.now(),
      parseDuration: null,

      issues: [],
    };

    // Remove the pending network size entry
    if (pendingTransfer !== null) this.networkSizes.delete(url);

    this.scripts.set(scriptId, record);
    this.callbacks.onScriptParsed?.(record);

    // Flag large bundles immediately (before source fetch)
    if (
      parsedSize !== null &&
      parsedSize >= this.config.largeBundleThresholdBytes
    ) {
      this.callbacks.onLargeBundle?.(record);
    }

    // Async: fetch source for deeper analysis if enabled
    if (this.config.fetchScriptSource) {
      this.analyzeScriptSource(scriptId).catch((err) => {
        console.debug(
          `[BundleAnalyzer] Source fetch failed for ${scriptName}:`,
          err
        );
      });
    }
  }

  // ── Async source analysis ─────────────────────────────────────────────────

  private async analyzeScriptSource(scriptId: string): Promise<void> {
    let sourceResponse: CDPGetScriptSourceResponse;

    try {
      sourceResponse = await this.sendCommand<CDPGetScriptSourceResponse>(
        "Debugger.getScriptSource",
        { scriptId }
      );
    } catch {
      return; // Script may have been GC'd
    }

    const { scriptSource } = sourceResponse;
    if (!scriptSource) return;

    const { libraries, bundler } = detectLibrariesFromSource(scriptSource);

    const current = this.scripts.get(scriptId);
    if (!current) return;

    // Merge URL-detected + source-detected libraries (deduplicate by name)
    const namesSeen = new Set(current.detectedLibraries.map((l) => l.name));
    const merged = [...current.detectedLibraries];
    for (const lib of libraries) {
      if (!namesSeen.has(lib.name)) {
        merged.push(lib);
        namesSeen.add(lib.name);
      }
    }

    // Use actual source length if V8 didn't provide it
    const parsedSize =
      current.parsedSize ?? new TextEncoder().encode(scriptSource).length;

    const updated: ScriptRecord = {
      ...current,
      parsedSize,
      estimatedGzip: estimateGzip(parsedSize),
      detectedLibraries: merged,
      bundler: bundler ?? current.bundler,
    };

    this.scripts.set(scriptId, updated);
  }

  // ── Coverage integration ──────────────────────────────────────────────────

  /**
   * Collect precise coverage from the Profiler and apply it to all records.
   * Call this after the page load (or the user interaction) you want to measure.
   */
  async collectCoverage(): Promise<void> {
    if (!this.config.enableCoverage) {
      console.warn(
        "[BundleAnalyzer] Coverage not enabled — set enableCoverage: true in config"
      );
      return;
    }

    let result: CDPCoverageResult;

    try {
      result = await this.sendCommand<CDPCoverageResult>(
        "Profiler.takePreciseCoverage"
      );
    } catch (err) {
      console.error("[BundleAnalyzer] Failed to collect coverage:", err);
      return;
    }

    for (const scriptCoverage of result.result) {
      const record = this.scripts.get(scriptCoverage.scriptId);
      if (!record) continue;

      const totalBytes = record.parsedSize;
      if (!totalBytes) continue;

      // Aggregate all covered byte ranges
      let coveredBytes = 0;
      for (const fn of scriptCoverage.functions) {
        for (const range of fn.ranges) {
          if (range.count > 0) {
            coveredBytes += range.endOffset - range.startOffset;
          }
        }
      }

      // Clamp to parsedSize (coverage ranges can overlap)
      coveredBytes = Math.min(coveredBytes, totalBytes);

      const unusedBytes = totalBytes - coveredBytes;
      const coverageRatio = coveredBytes / totalBytes;

      this.scripts.set(scriptCoverage.scriptId, {
        ...record,
        usedBytes: coveredBytes,
        unusedBytes,
        coverageRatio,
      });
    }
  }

  // ── Report generation ─────────────────────────────────────────────────────

  /**
   * Generate a full BundleAnalysisReport from all captured scripts.
   */
  async generateReport(pageUrl = this.pageUrl): Promise<BundleAnalysisReport> {
    this.pageUrl = pageUrl;

    // Optionally snapshot coverage first
    if (this.config.enableCoverage) {
      await this.collectCoverage();
    }

    const allScripts = Array.from(this.scripts.values());

    // Re-run issue detection with latest data
    for (const script of allScripts) {
      const issues = detectIssues(script, this.config);
      this.scripts.set(script.scriptId, { ...script, issues });
    }

    const refreshed = Array.from(this.scripts.values());
    const globalIssues = detectGlobalIssues(refreshed, this.config);

    // ── Aggregates ────────────────────────────────────────────────────────
    const totalParsedBytes = sum(refreshed, (s) => s.parsedSize ?? 0);
    const totalTransferBytes = sum(refreshed, (s) => s.transferSize ?? 0);
    const totalEstimatedGzip = sum(refreshed, (s) => s.estimatedGzip ?? 0);
    const totalUsedBytes = sum(refreshed, (s) => s.usedBytes ?? 0);
    const totalUnusedBytes = sum(refreshed, (s) => s.unusedBytes ?? 0);

    const measuredScripts = refreshed.filter((s) => s.coverageRatio !== null);
    const overallCoverage =
      measuredScripts.length > 0
        ? sum(measuredScripts, (s) => s.usedBytes ?? 0) /
          Math.max(
            1,
            sum(measuredScripts, (s) => s.parsedSize ?? 0)
          )
        : null;

    // ── By-origin buckets ─────────────────────────────────────────────────
    const byOrigin: Partial<Record<ScriptOrigin, OriginBucket>> = {};

    for (const s of refreshed) {
      const b = byOrigin[s.origin] ?? {
        count: 0,
        totalBytes: 0,
        unusedBytes: 0,
        scriptIds: [],
      };
      b.count++;
      b.totalBytes += s.parsedSize ?? 0;
      b.unusedBytes += s.unusedBytes ?? 0;
      b.scriptIds.push(s.scriptId);
      byOrigin[s.origin] = b;
    }

    // ── Top lists ─────────────────────────────────────────────────────────
    const toSummary = (s: ScriptRecord): ScriptSummary => ({
      scriptId: s.scriptId,
      url: s.url,
      scriptName: s.scriptName,
      parsedSize: s.parsedSize,
      transferSize: s.transferSize,
      unusedBytes: s.unusedBytes,
      coverageRatio: s.coverageRatio,
      classification: s.classification,
      detectedLibraries: s.detectedLibraries,
      issueCount: s.issues.length,
    });

    const sortedBySize = [...refreshed].sort(
      (a, b) => (b.parsedSize ?? 0) - (a.parsedSize ?? 0)
    );
    const sortedByUnused = [...refreshed]
      .filter((s) => s.unusedBytes !== null)
      .sort((a, b) => (b.unusedBytes ?? 0) - (a.unusedBytes ?? 0));

    // ── All detected libraries (deduplicated) ─────────────────────────────
    const libMap = new Map<string, DetectedLibrary>();
    for (const s of refreshed) {
      for (const lib of s.detectedLibraries) {
        const key = lib.name.toLowerCase();
        if (!libMap.has(key)) libMap.set(key, lib);
      }
    }

    // ── Score ─────────────────────────────────────────────────────────────
    const { score, breakdown } = computeBundleScore(
      refreshed,
      totalParsedBytes,
      this.config
    );

    // ── All issues (script-level + global) ────────────────────────────────
    const allIssues = [
      ...globalIssues,
      ...refreshed.flatMap((s) => s.issues),
    ].sort((a, b) => {
      const order = { critical: 0, warning: 1, info: 2 };
      return order[a.severity] - order[b.severity];
    });

    return {
      generatedAt: Date.now(),
      pageUrl,
      totalScripts: refreshed.length,
      inlineScripts: refreshed.filter((s) => s.origin === "inline").length,
      externalScripts: refreshed.filter((s) => s.url.startsWith("http")).length,
      moduleScripts: refreshed.filter((s) => s.isModule).length,
      totalParsedBytes,
      totalTransferBytes,
      totalEstimatedGzip,
      totalUsedBytes,
      totalUnusedBytes,
      overallCoverageRatio: overallCoverage,
      byOrigin: byOrigin as Record<ScriptOrigin, OriginBucket>,
      largestBundles: sortedBySize.slice(0, 10).map(toSummary),
      mostUnused: sortedByUnused.slice(0, 10).map(toSummary),
      allIssues,
      detectedLibraries: Array.from(libMap.values()),
      score,
      scoreBreakdown: breakdown,
    };
  }

  // ── Public read API ───────────────────────────────────────────────────────

  getScript(scriptId: string): ScriptRecord | undefined {
    return this.scripts.get(scriptId);
  }

  getAllScripts(): ScriptRecord[] {
    return Array.from(this.scripts.values());
  }

  getLargeScripts(): ScriptRecord[] {
    return this.getAllScripts().filter(
      (s) => (s.parsedSize ?? 0) >= this.config.largeBundleThresholdBytes
    );
  }

  get isAttached(): boolean {
    return this.attached;
  }
  get scriptCount(): number {
    return this.scripts.size;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private shouldExclude(url: string): boolean {
    for (const pattern of this.config.excludePatterns) {
      if (url.includes(pattern)) return true;
    }
    return false;
  }

  private sendCommand<T = unknown>(
    method: string,
    params?: object
  ): Promise<T> {
    return chrome.debugger.sendCommand(
      { tabId: this.tabId },
      method,
      params ?? {}
    ) as Promise<T>;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function sum<T>(arr: T[], fn: (item: T) => number): number {
  return arr.reduce((acc, item) => acc + fn(item), 0);
}
