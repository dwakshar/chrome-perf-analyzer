// ─────────────────────────────────────────────────────────────────────────────
// network.types.ts
//
// All typed shapes for CDP Network domain events and derived timing structures.
// ─────────────────────────────────────────────────────────────────────────────

// ── CDP Raw Payloads ──────────────────────────────────────────────────────────

export interface CDPRequestWillBeSent {
  requestId: string;
  loaderId: string;
  documentURL: string;
  request: CDPRequest;
  timestamp: number; // Seconds since Chrome epoch
  wallTime: number; // Unix timestamp (seconds)
  initiator: CDPInitiator;
  redirectResponse?: CDPResponse;
  type: ResourceType;
  frameId?: string;
}

export interface CDPResponseReceived {
  requestId: string;
  loaderId: string;
  timestamp: number;
  type: ResourceType;
  response: CDPResponse;
  frameId?: string;
}

export interface CDPLoadingFinished {
  requestId: string;
  timestamp: number;
  encodedDataLength: number;
  shouldReportCorbBlocking?: boolean;
}

export interface CDPLoadingFailed {
  requestId: string;
  timestamp: number;
  type: ResourceType;
  errorText: string;
  canceled?: boolean;
  blockedReason?: string;
  corsErrorStatus?: { corsError: string; failedParameter: string };
}

export interface CDPRequest {
  url: string;
  method: HTTPMethod;
  headers: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
  mixedContentType?: string;
  initialPriority: ResourcePriority;
}

export interface CDPResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  mimeType: string;
  connectionReused: boolean;
  connectionId: number;
  remoteIPAddress?: string;
  remotePort?: number;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  fromPrefetchCache?: boolean;
  encodedDataLength: number;
  timing?: CDPResourceTiming;
  protocol?: string;
  securityState: string;
}

/** Raw Chrome resource timing offsets (all in ms relative to requestTime) */
export interface CDPResourceTiming {
  requestTime: number; // Seconds since Chrome epoch (base)
  proxyStart: number;
  proxyEnd: number;
  dnsStart: number;
  dnsEnd: number;
  connectStart: number;
  connectEnd: number;
  sslStart: number;
  sslEnd: number;
  workerStart: number;
  workerReady: number;
  workerFetchStart: number;
  workerRespondWithSettled: number;
  sendStart: number;
  sendEnd: number;
  pushStart: number;
  pushEnd: number;
  receiveHeadersEnd: number;
}

export interface CDPInitiator {
  type:
    | "parser"
    | "script"
    | "preload"
    | "SignedExchange"
    | "preflight"
    | "other";
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stack?: CDPStackTrace;
  requestId?: string;
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

// ── Derived Timing Model ──────────────────────────────────────────────────────

/**
 * Fully computed, human-readable timing breakdown for a single request.
 * All durations are in milliseconds.
 */
export interface RequestTimingBreakdown {
  /** DNS resolution time */
  dns: number | null;
  /** TCP + TLS handshake */
  connect: number | null;
  /** TLS negotiation (subset of connect) */
  ssl: number | null;
  /** Time blocked in queue before sending */
  blocked: number | null;
  /** Time to send the request bytes */
  send: number | null;
  /** Time waiting for first byte (TTFB) */
  wait: number | null;
  /** Time receiving response body */
  receive: number | null;
  /** Total end-to-end duration */
  total: number;
}

/**
 * Fully enriched network request record produced by NetworkCollector.
 */
export interface NetworkRequest {
  // ── Identity ──────────────────────────────────────────────────────────────
  requestId: string;
  url: string;
  method: HTTPMethod;
  resourceType: ResourceType;
  initiator: CDPInitiator;

  // ── Status ────────────────────────────────────────────────────────────────
  state: RequestState;
  statusCode: number | null;
  statusText: string | null;
  mimeType: string | null;
  protocol: string | null;

  // ── Size ──────────────────────────────────────────────────────────────────
  encodedBodySize: number | null; // bytes over wire
  transferSize: number | null; // total including headers
  fromCache: boolean;
  fromServiceWorker: boolean;

  // ── Timing ────────────────────────────────────────────────────────────────
  /** Absolute wall-clock start time (ms since epoch) */
  startTime: number;
  /** Absolute wall-clock end time (ms since epoch), null if in-flight */
  endTime: number | null;
  /** Total duration in ms, null if in-flight */
  duration: number | null;
  /** Detailed phase breakdown, null until response received */
  timing: RequestTimingBreakdown | null;
  /** Raw CDP timing offsets (preserved for custom analysis) */
  rawTiming: CDPResourceTiming | null;

  // ── Headers ───────────────────────────────────────────────────────────────
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string> | null;

  // ── Error ─────────────────────────────────────────────────────────────────
  error: RequestError | null;
}

export interface RequestError {
  text: string;
  canceled: boolean;
  blockedReason?: string;
}

// ── Aggregated Report ─────────────────────────────────────────────────────────

export interface TimingReport {
  /** Snapshot timestamp */
  generatedAt: number;
  /** Total number of requests captured */
  totalRequests: number;
  /** Requests that completed successfully */
  completedRequests: number;
  /** Requests that failed */
  failedRequests: number;
  /** Requests still in-flight */
  pendingRequests: number;

  /** Aggregate durations across all completed requests */
  aggregates: TimingAggregates;
  /** Per resource-type breakdown */
  byType: Record<ResourceType, TypeBucket>;
  /** Slowest N requests */
  slowest: SlowRequest[];
  /** Requests exceeding the configured slow threshold */
  bottlenecks: SlowRequest[];
}

export interface TimingAggregates {
  min: number;
  max: number;
  mean: number;
  median: number;
  p75: number;
  p95: number;
  p99: number;
  total: number;
}

export interface TypeBucket {
  count: number;
  totalBytes: number;
  meanDuration: number;
  maxDuration: number;
}

export interface SlowRequest {
  requestId: string;
  url: string;
  method: HTTPMethod;
  duration: number;
  statusCode: number | null;
  resourceType: ResourceType;
  timing: RequestTimingBreakdown | null;
}

// ── Filter / Config ───────────────────────────────────────────────────────────

export interface NetworkMonitorConfig {
  /** Requests longer than this (ms) are flagged as bottlenecks. Default: 1000 */
  slowThresholdMs: number;
  /** Max requests to keep in the ring buffer. Default: 500 */
  maxRequests: number;
  /** Only track these resource types (empty = all) */
  filterTypes: ResourceType[];
  /** URL patterns to exclude (substring match) */
  excludePatterns: string[];
  /** Emit live events via the onRequest callback */
  enableLiveCallbacks: boolean;
}

export interface NetworkMonitorCallbacks {
  /** Called when a new request starts */
  onRequestStart?: (req: NetworkRequest) => void;
  /** Called when a request completes (success or failure) */
  onRequestComplete?: (req: NetworkRequest) => void;
  /** Called when a request exceeds the slow threshold */
  onSlowRequest?: (req: NetworkRequest) => void;
  /** Called after each report generation */
  onReport?: (report: TimingReport) => void;
}

// ── Enums / Unions ────────────────────────────────────────────────────────────

export type HTTPMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "CONNECT"
  | "TRACE";

export type ResourceType =
  | "Document"
  | "Stylesheet"
  | "Image"
  | "Media"
  | "Font"
  | "Script"
  | "TextTrack"
  | "XHR"
  | "Fetch"
  | "Preflight"
  | "EventSource"
  | "WebSocket"
  | "Manifest"
  | "SignedExchange"
  | "Ping"
  | "CSPViolationReport"
  | "Prefetch"
  | "Other";

export type ResourcePriority =
  | "VeryLow"
  | "Low"
  | "Medium"
  | "High"
  | "VeryHigh";

export type RequestState =
  | "pending"
  | "responded"
  | "complete"
  | "failed"
  | "canceled";
