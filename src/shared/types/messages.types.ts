// ─────────────────────────────────────────────────────────────────────────────
// Message Contract Types
// Shared between: service-worker ↔ devtools panel ↔ content script
// ─────────────────────────────────────────────────────────────────────────────

export type MessageType =
  | "DEVTOOLS_OPENED"
  | "DEVTOOLS_CLOSED"
  | "PANEL_READY"
  | "CLEAR_SESSION"
  | "RECORDING_START"
  | "RECORDING_STOP"
  | "METRICS_UPDATE"
  | "ANALYSIS_RESULT"
  | "SESSION_INIT"
  | "SESSION_HYDRATE"
  | "CDP_EVENT"
  | "ERROR";

export interface ExtensionMessage<T = unknown> {
  type: MessageType;
  tabId: number;
  timestamp: number;
  payload: T;
}

// ── Session ──────────────────────────────────────────────────────────────────

export interface SessionInitPayload {
  tabId: number;
  tabUrl: string;
  sessionId: string;
}

export interface SessionHydratePayload {
  sessionId: string;
  recordingState: "idle" | "recording" | "paused";
  metricsSnapshot: MetricsSnapshot | null;
  analysisSnapshot: AnalysisResultPayload | null;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

export interface CoreWebVitals {
  lcp: number | null; // Largest Contentful Paint (ms)
  cls: number | null; // Cumulative Layout Shift (score)
  inp: number | null; // Interaction to Next Paint (ms)
  fcp: number | null; // First Contentful Paint (ms)
  ttfb: number | null; // Time to First Byte (ms)
}

export interface LongTask {
  startTime: number; // ms since navigation
  duration: number; // ms
  scriptUrl?: string;
  functionName?: string;
}

export interface NetworkRequest {
  requestId: string;
  url: string;
  method: string;
  startTime: number;
  endTime?: number;
  statusCode?: number;
  transferSize?: number;
  resourceType: string;
  blocked: boolean;
}

export interface HeapSummary {
  usedJSHeapSize: number; // bytes
  totalJSHeapSize: number; // bytes
  timestamp: number;
}

export interface PaintEvent {
  type: "layout" | "paint" | "composite" | "style-recalc";
  startTime: number;
  duration: number;
  nodeCount?: number;
}

export interface MetricsSnapshot {
  cwv: CoreWebVitals;
  longTasks: LongTask[];
  networkRequests: NetworkRequest[];
  heapTimeline: HeapSummary[];
  paintEvents: PaintEvent[];
  recordingStart: number;
}

// ── Analysis ─────────────────────────────────────────────────────────────────

export type IssueSeverity = "critical" | "warning" | "info";
export type IssueCategory = "rendering" | "network" | "memory" | "javascript";

export interface PerformanceIssue {
  id: string;
  severity: IssueSeverity;
  category: IssueCategory;
  title: string;
  detail: string;
  timeRange?: [number, number];
  affectedNode?: string;
  recommendation: string;
}

export interface AnalysisResultPayload {
  issues: PerformanceIssue[];
  score: number; // 0–100
  recommendations: string[];
  analyzedAt: number;
}
