// ─────────────────────────────────────────────────────────────────────────────
// network-collector.ts
//
// Primary module.  Subscribes to CDP Network.* events via the Chrome Debugger
// API and builds a fully-enriched NetworkRequest record for every request.
//
// Usage (from the extension service worker):
//
//   const collector = new NetworkCollector(tabId, {
//     slowThresholdMs: 1500,
//     maxRequests: 300,
//   }, {
//     onSlowRequest: (req) => console.warn('SLOW', req.url, req.duration),
//   });
//
//   await collector.attach();
//   // ... later ...
//   const report = collector.generateReport();
//   await collector.detach();
//
// ─────────────────────────────────────────────────────────────────────────────

import type {
  CDPLoadingFailed,
  CDPLoadingFinished,
  CDPRequestWillBeSent,
  CDPResponseReceived,
  NetworkMonitorCallbacks,
  NetworkMonitorConfig,
  NetworkRequest,
  ResourceType,
  SlowRequest,
  TimingReport,
  TypeBucket,
} from "../shared/types/network.types.js";

import {
  computeStats,
  computeTimingBreakdown,
} from "../analyzers/timing-calculator.js";
import { RingBuffer } from "../shared/ring-buffer.js";

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: NetworkMonitorConfig = {
  slowThresholdMs: 1000,
  maxRequests: 500,
  filterTypes: [],
  excludePatterns: [],
  enableLiveCallbacks: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// NetworkCollector
// ─────────────────────────────────────────────────────────────────────────────

export class NetworkCollector {
  private readonly tabId: number;
  private readonly config: NetworkMonitorConfig;
  private readonly callbacks: NetworkMonitorCallbacks;

  /** Circular buffer of completed + in-flight requests */
  private readonly requests: RingBuffer<NetworkRequest>;

  /** Quick-access map: requestId → buffer item (avoids full scans on updates) */
  private readonly index = new Map<string, NetworkRequest>();

  private attached = false;
  private sessionStart = 0;

  // ── Bound handlers (needed for removeListener) ────────────────────────────
  private readonly boundOnEvent = this.onCDPEvent.bind(this);
  private readonly boundOnDetach = this.onDebuggerDetach.bind(this);

  constructor(
    tabId: number,
    config?: Partial<NetworkMonitorConfig>,
    callbacks?: NetworkMonitorCallbacks
  ) {
    this.tabId = tabId;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.callbacks = callbacks ?? {};
    this.requests = new RingBuffer<NetworkRequest>(this.config.maxRequests);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Attach to the Chrome Debugger and enable the Network domain.
   * Safe to call multiple times — idempotent.
   */
  async attach(): Promise<void> {
    if (this.attached) return;

    await chrome.debugger.attach({ tabId: this.tabId }, "1.3");

    await chrome.debugger.sendCommand({ tabId: this.tabId }, "Network.enable", {
      maxTotalBufferSize: 10 * 1024 * 1024, // 10 MB
      maxResourceBufferSize: 5 * 1024 * 1024, // 5 MB
      maxPostDataSize: 65_536, // 64 KB
    });

    chrome.debugger.onEvent.addListener(this.boundOnEvent);
    chrome.debugger.onDetach.addListener(this.boundOnDetach);

    this.attached = true;
    this.sessionStart = Date.now();

    console.info(`[NetworkCollector] Attached to tab ${this.tabId}`);
  }

  /**
   * Detach from the Chrome Debugger and clean up listeners.
   */
  async detach(): Promise<void> {
    if (!this.attached) return;

    chrome.debugger.onEvent.removeListener(this.boundOnEvent);
    chrome.debugger.onDetach.removeListener(this.boundOnDetach);

    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch {
      // Tab may already be closed.
    }

    this.attached = false;
    console.info(`[NetworkCollector] Detached from tab ${this.tabId}`);
  }

  /** Remove all stored requests but keep the collector attached. */
  clear(): void {
    this.requests.clear();
    this.index.clear();
  }

  // ── CDP Event routing ─────────────────────────────────────────────────────

  private onCDPEvent(
    source: chrome.debugger.Debuggee,
    method: string,
    params?: unknown
  ): void {
    if (source.tabId !== this.tabId) return;

    switch (method) {
      case "Network.requestWillBeSent":
        this.handleRequestWillBeSent(params as CDPRequestWillBeSent);
        break;
      case "Network.responseReceived":
        this.handleResponseReceived(params as CDPResponseReceived);
        break;
      case "Network.loadingFinished":
        this.handleLoadingFinished(params as CDPLoadingFinished);
        break;
      case "Network.loadingFailed":
        this.handleLoadingFailed(params as CDPLoadingFailed);
        break;
    }
  }

  private onDebuggerDetach(
    source: chrome.debugger.Debuggee,
    _reason: string
  ): void {
    if (source.tabId === this.tabId) {
      this.attached = false;
      console.warn(
        `[NetworkCollector] Debugger detached unexpectedly from tab ${this.tabId}`
      );
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  private handleRequestWillBeSent(event: CDPRequestWillBeSent): void {
    // Filter by resource type if configured
    if (!this.shouldTrack(event.type, event.request.url)) return;

    // Handle redirects: update the existing record's redirect chain, then
    // create a fresh record for the new request leg.
    if (event.redirectResponse && this.index.has(event.requestId)) {
      this.finalizeRedirect(event);
    }

    const req: NetworkRequest = {
      requestId: event.requestId,
      url: event.request.url,
      method: event.request.method as NetworkRequest["method"],
      resourceType: event.type,
      initiator: event.initiator,

      state: "pending",
      statusCode: null,
      statusText: null,
      mimeType: null,
      protocol: null,

      encodedBodySize: null,
      transferSize: null,
      fromCache: false,
      fromServiceWorker: false,

      startTime: event.wallTime * 1000, // Convert to ms-epoch
      endTime: null,
      duration: null,
      timing: null,
      rawTiming: null,

      requestHeaders: event.request.headers,
      responseHeaders: null,

      error: null,
    };

    this.store(req);

    if (this.config.enableLiveCallbacks) {
      this.callbacks.onRequestStart?.(req);
    }
  }

  private handleResponseReceived(event: CDPResponseReceived): void {
    const req = this.index.get(event.requestId);
    if (!req) return;

    const res = event.response;

    const updated: NetworkRequest = {
      ...req,
      state: "responded",
      statusCode: res.status,
      statusText: res.statusText,
      mimeType: res.mimeType,
      protocol: res.protocol ?? null,
      fromCache: !!(res.fromDiskCache || res.fromPrefetchCache),
      fromServiceWorker: !!res.fromServiceWorker,
      responseHeaders: res.headers,
      rawTiming: res.timing ?? null,
    };

    this.store(updated);
  }

  private handleLoadingFinished(event: CDPLoadingFinished): void {
    const req = this.index.get(event.requestId);
    if (!req) return;

    const endTime = Date.now(); // Wall clock approximation
    const duration = endTime - req.startTime;

    let timing = req.timing;

    // Compute phase breakdown if we have raw CDP timing.
    if (req.rawTiming) {
      timing = computeTimingBreakdown(req.rawTiming, event.timestamp);
    } else if (req.startTime > 0) {
      // Fallback: total duration only.
      timing = {
        dns: null,
        connect: null,
        ssl: null,
        blocked: null,
        send: null,
        wait: null,
        receive: null,
        total: duration,
      };
    }

    const updated: NetworkRequest = {
      ...req,
      state: "complete",
      endTime,
      duration,
      timing,
      encodedBodySize: event.encodedDataLength,
      transferSize: event.encodedDataLength,
    };

    this.store(updated);

    if (this.config.enableLiveCallbacks) {
      this.callbacks.onRequestComplete?.(updated);

      if (duration >= this.config.slowThresholdMs) {
        this.callbacks.onSlowRequest?.(updated);
      }
    }
  }

  private handleLoadingFailed(event: CDPLoadingFailed): void {
    const req = this.index.get(event.requestId);
    if (!req) return;

    const endTime = Date.now();
    const duration = endTime - req.startTime;

    const updated: NetworkRequest = {
      ...req,
      state: event.canceled ? "canceled" : "failed",
      endTime,
      duration,
      error: {
        text: event.errorText,
        canceled: !!event.canceled,
        ...(event.blockedReason && { blockedReason: event.blockedReason }),
      },
    };

    this.store(updated);

    if (this.config.enableLiveCallbacks) {
      this.callbacks.onRequestComplete?.(updated);
    }
  }

  // ── Redirect handling ─────────────────────────────────────────────────────

  private finalizeRedirect(event: CDPRequestWillBeSent): void {
    const prev = this.index.get(event.requestId);
    if (!prev || !event.redirectResponse) return;

    const redirectRes = event.redirectResponse;
    const endTime = event.timestamp * 1000; // CDP monotonic → ms approx
    const duration = endTime - prev.startTime;

    const finalized: NetworkRequest = {
      ...prev,
      state: "complete",
      statusCode: redirectRes.status,
      statusText: redirectRes.statusText,
      responseHeaders: redirectRes.headers,
      endTime: Date.now(),
      duration,
    };

    // Store the redirect leg under a synthetic key so it doesn't collide.
    const redirectKey = `${event.requestId}_redirect_${Date.now()}`;
    this.requests.push({ ...finalized, requestId: redirectKey });
    // (Don't add to index — it's a historical record, not updatable)
  }

  // ── Storage helpers ───────────────────────────────────────────────────────

  private store(req: NetworkRequest): void {
    const existing = this.index.get(req.requestId);

    if (existing) {
      // Update in-place inside the ring buffer.
      this.requests.upsert(req, (r) => r.requestId === req.requestId);
    } else {
      this.requests.push(req);
    }

    this.index.set(req.requestId, req);
  }

  private shouldTrack(type: ResourceType, url: string): boolean {
    if (
      this.config.filterTypes.length > 0 &&
      !this.config.filterTypes.includes(type)
    ) {
      return false;
    }

    for (const pattern of this.config.excludePatterns) {
      if (url.includes(pattern)) return false;
    }

    return true;
  }

  // ── Public read API ───────────────────────────────────────────────────────

  /** All tracked requests (oldest → newest). */
  getAllRequests(): NetworkRequest[] {
    return this.requests.toArray();
  }

  /** Lookup a single request by ID. */
  getRequest(requestId: string): NetworkRequest | undefined {
    return this.index.get(requestId);
  }

  /** All completed requests only. */
  getCompletedRequests(): NetworkRequest[] {
    return this.requests.filter((r) => r.state === "complete");
  }

  /** All failed / canceled requests. */
  getFailedRequests(): NetworkRequest[] {
    return this.requests.filter(
      (r) => r.state === "failed" || r.state === "canceled"
    );
  }

  /** Requests whose duration exceeds the configured slow threshold. */
  getBottlenecks(): NetworkRequest[] {
    return this.requests.filter(
      (r) => r.duration !== null && r.duration >= this.config.slowThresholdMs
    );
  }

  get isAttached(): boolean {
    return this.attached;
  }
  get requestCount(): number {
    return this.requests.size;
  }

  // ── Report generation ─────────────────────────────────────────────────────

  /**
   * Generate a full timing report from all captured requests.
   * Suitable for serialization and display in the DevTools panel.
   */
  generateReport(topN = 10): TimingReport {
    const all = this.requests.toArray();
    const completed = all.filter(
      (r) => r.state === "complete" && r.duration !== null
    );
    const failed = all.filter(
      (r) => r.state === "failed" || r.state === "canceled"
    );
    const pending = all.filter(
      (r) => r.state === "pending" || r.state === "responded"
    );

    const durations = completed.map((r) => r.duration!);
    const aggregates = computeStats(durations);

    // ── Per-type buckets ──────────────────────────────────────────────────
    const byType: Partial<Record<ResourceType, TypeBucket>> = {};

    for (const req of completed) {
      const t = req.resourceType;
      const bucket = byType[t] ?? {
        count: 0,
        totalBytes: 0,
        meanDuration: 0,
        maxDuration: 0,
      };

      bucket.count++;
      bucket.totalBytes += req.encodedBodySize ?? 0;
      bucket.maxDuration = Math.max(bucket.maxDuration, req.duration!);
      // Incremental mean update: mean_n = mean_{n-1} + (x - mean_{n-1}) / n
      bucket.meanDuration +=
        (req.duration! - bucket.meanDuration) / bucket.count;

      byType[t] = bucket;
    }

    // ── Slowest N ─────────────────────────────────────────────────────────
    const sorted = [...completed].sort(
      (a, b) => (b.duration ?? 0) - (a.duration ?? 0)
    );

    const toSlowRequest = (r: NetworkRequest): SlowRequest => ({
      requestId: r.requestId,
      url: r.url,
      method: r.method,
      duration: r.duration!,
      statusCode: r.statusCode,
      resourceType: r.resourceType,
      timing: r.timing,
    });

    const slowest = sorted.slice(0, topN).map(toSlowRequest);
    const bottlenecks = sorted
      .filter((r) => r.duration! >= this.config.slowThresholdMs)
      .map(toSlowRequest);

    return {
      generatedAt: Date.now(),
      totalRequests: all.length,
      completedRequests: completed.length,
      failedRequests: failed.length,
      pendingRequests: pending.length,
      aggregates,
      byType: byType as Record<ResourceType, TypeBucket>,
      slowest,
      bottlenecks,
    };
  }
}
