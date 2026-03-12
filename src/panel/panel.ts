/**
 * panel.ts
 *
 * Runs inside the DevTools panel page (panel.html).
 * Responsibilities:
 *   • Signal PANEL_READY to service worker on mount
 *   • Receive session hydration payload and restore UI state
 *   • Subscribe to METRICS_UPDATE and ANALYSIS_RESULT messages
 *   • Render Core Web Vitals, issues list, and recording controls
 */

import type {
  AnalysisResultPayload,
  CoreWebVitals,
  ExtensionMessage,
  MetricsSnapshot,
  PerformanceIssue,
  SessionHydratePayload,
} from "../shared/types/messages.types.js";

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

interface PanelState {
  tabId: number;
  recording: boolean;
  sessionId: string | null;
  metricsSnapshot: MetricsSnapshot | null;
  issues: PerformanceIssue[];
}

const state: PanelState = {
  tabId: -1,
  recording: false,
  sessionId: null,
  metricsSnapshot: null,
  issues: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const recordBtn = $<HTMLButtonElement>("record-btn");
const recordLabel = $<HTMLSpanElement>("record-label");
const clearBtn = $<HTMLButtonElement>("clear-btn");
const sessionInfo = $<HTMLSpanElement>("session-info");
const statusDot = $<HTMLSpanElement>("status-dot");
const statusText = $<HTMLSpanElement>("status-text");
const idleState = $<HTMLDivElement>("idle-state");
const recordingState = $<HTMLDivElement>("recording-state");
const issuesList = $<HTMLDivElement>("issues-list");

// CWV metric elements
const cwvEls = {
  lcp: $<HTMLSpanElement>("lcp-value"),
  cls: $<HTMLSpanElement>("cls-value"),
  inp: $<HTMLSpanElement>("inp-value"),
  fcp: $<HTMLSpanElement>("fcp-value"),
  ttfb: $<HTMLSpanElement>("ttfb-value"),
};

const runtimeEls = {
  longTasks: $<HTMLSpanElement>("long-tasks-value"),
  heap: $<HTMLSpanElement>("heap-value"),
};

const timelineCanvas = $<HTMLCanvasElement>("timeline-canvas");
const timelineCtx = timelineCanvas?.getContext("2d") ?? null;

interface TimelinePoint {
  timestamp: number;
  cwv: CoreWebVitals;
}

const timelineHistory: TimelinePoint[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────

async function waitForTabId(timeoutMs = 5000): Promise<number> {
  const start = Date.now();

  // The devtools page sets __PERF_TAB_ID__ on the panel window from its
  // panel.onShown callback. Depending on load order this can race with our
  // DOMContentLoaded handler, so we poll briefly until it appears.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = (window as Window & { __PERF_TAB_ID__?: number })
      .__PERF_TAB_ID__;

    if (typeof candidate === "number" && candidate >= 0) {
      return candidate;
    }

    if (Date.now() - start > timeoutMs) {
      // Fallback: we failed to detect a tab id; use sentinel -1.
      return -1;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function init(): Promise<void> {
  state.tabId = await waitForTabId();

  setStatus("connecting", `Connecting to tab ${state.tabId}…`);
  sessionInfo.textContent = `Tab ${state.tabId}`;

  // Tell service worker we're ready — it will push back session state.
  const hydration = await sendToServiceWorker<SessionHydratePayload>(
    "PANEL_READY",
    null
  );

  if (hydration) {
    applyHydration(hydration);
  }

  setStatus("connected", "Connected");
  wireControls();
  wireServiceWorkerMessages();
}

// ─────────────────────────────────────────────────────────────────────────────
// Hydration (restoring state after SW restart or panel re-mount)
// ─────────────────────────────────────────────────────────────────────────────

function applyHydration(hydration: SessionHydratePayload): void {
  state.sessionId = hydration.sessionId;
  state.recording = hydration.recordingState === "recording";

  if (hydration.metricsSnapshot) {
    timelineHistory.length = 0;
    timelineHistory.push({
      timestamp: hydration.metricsSnapshot.recordingStart,
      cwv: hydration.metricsSnapshot.cwv,
    });

    renderMetrics(hydration.metricsSnapshot.cwv);
    renderRuntimeMetrics(hydration.metricsSnapshot);
    renderTimeline();
  }

  updateRecordUI();
}

// ─────────────────────────────────────────────────────────────────────────────
// Service worker message subscription
// ─────────────────────────────────────────────────────────────────────────────

function wireServiceWorkerMessages(): void {
  chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
    // Lazily bind to the first tab that sends us data if we failed to
    // initialise from __PERF_TAB_ID__ for any reason.
    if (state.tabId === -1) {
      state.tabId = message.tabId;
      sessionInfo.textContent = `Tab ${state.tabId}`;
    }

    if (message.tabId !== state.tabId) return;

    switch (message.type) {
      case "METRICS_UPDATE":
        handleMetricsUpdate(message.payload as MetricsSnapshot);
        break;

      case "ANALYSIS_RESULT":
        handleAnalysisResult(message.payload as AnalysisResultPayload);
        break;

      case "CDP_EVENT":
        // Raw CDP events — forwarded for timeline rendering (future).
        break;
    }
  });
}

function handleMetricsUpdate(snapshot: MetricsSnapshot): void {
  state.metricsSnapshot = snapshot;

  timelineHistory.push({
    timestamp: Date.now(),
    cwv: snapshot.cwv,
  });
  // Keep only the most recent 120 points to bound work.
  if (timelineHistory.length > 120) {
    timelineHistory.splice(0, timelineHistory.length - 120);
  }

  renderMetrics(snapshot.cwv);
  renderRuntimeMetrics(snapshot);
  renderTimeline();
}

function handleAnalysisResult(result: AnalysisResultPayload): void {
  state.issues = result.issues;
  renderIssues(result.issues);
}

// ─────────────────────────────────────────────────────────────────────────────
// Controls
// ─────────────────────────────────────────────────────────────────────────────

function wireControls(): void {
  recordBtn.addEventListener("click", async () => {
    if (state.recording) {
      await sendToServiceWorker("RECORDING_STOP", null);
      state.recording = false;
    } else {
      await sendToServiceWorker("RECORDING_START", null);
      state.recording = true;
    }
    updateRecordUI();
  });

  clearBtn.addEventListener("click", () => {
    state.metricsSnapshot = null;
    state.issues = [];
    resetMetricsUI();
    renderIssues([]);
    setStatus("connected", "Cleared");
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderMetrics(cwv: CoreWebVitals): void {
  updateMetricEl(cwvEls.lcp, cwv.lcp, "ms", [2500, 4000]);
  updateMetricEl(cwvEls.cls, cwv.cls, "", [0.1, 0.25], 3);
  updateMetricEl(cwvEls.inp, cwv.inp, "ms", [200, 500]);
  updateMetricEl(cwvEls.fcp, cwv.fcp, "ms", [1800, 3000]);
  updateMetricEl(cwvEls.ttfb, cwv.ttfb, "ms", [800, 1800]);
}

function updateMetricEl(
  el: HTMLSpanElement,
  value: number | null,
  unit: string,
  thresholds: [number, number],
  decimals = 0
): void {
  if (value === null) {
    el.textContent = "—";
    el.className = "metric-value null";
    return;
  }

  const formatted = value.toFixed(decimals);
  el.innerHTML = `${formatted}<span class="metric-unit">${unit}</span>`;

  if (value <= thresholds[0]) el.className = "metric-value good";
  else if (value <= thresholds[1])
    el.className = "metric-value needs-improvement";
  else el.className = "metric-value poor";
}

function renderRuntimeMetrics(snapshot: MetricsSnapshot): void {
  // Long tasks count
  const ltCount = snapshot.longTasks.length;
  runtimeEls.longTasks.textContent = String(ltCount);
  runtimeEls.longTasks.className = `metric-value ${
    ltCount === 0 ? "good" : ltCount < 5 ? "needs-improvement" : "poor"
  }`;

  // Latest heap snapshot
  const latestHeap = snapshot.heapTimeline.at(-1);
  if (latestHeap) {
    const mb = (latestHeap.usedJSHeapSize / 1_048_576).toFixed(1);
    runtimeEls.heap.innerHTML = `${mb}<span class="metric-unit">MB</span>`;
    runtimeEls.heap.className = "metric-value";
  }

  // Show timeline canvas
  idleState.style.display = "none";
  recordingState.style.display = "block";
}

function renderIssues(issues: PerformanceIssue[]): void {
  if (issues.length === 0) {
    issuesList.innerHTML = `
      <div class="issue-item" style="color:var(--text-dim); font-size:11px; font-family:var(--font-mono);">
        No issues detected yet.
      </div>`;
    return;
  }

  const sorted = [...issues].sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  });

  issuesList.innerHTML = sorted
    .map(
      (issue) => `
    <div class="issue-item">
      <span class="issue-badge ${issue.severity}">${issue.severity}</span>
      <div>
        <div class="issue-title">${escapeHtml(issue.title)}</div>
        <div class="issue-detail">${escapeHtml(issue.detail)}</div>
      </div>
    </div>
  `
    )
    .join("");
}

function updateRecordUI(): void {
  if (state.recording) {
    recordBtn.classList.add("recording");
    recordLabel.textContent = "Stop";
    setStatus("recording", "Recording…");
    idleState.style.display = "none";
    recordingState.style.display = "block";
  } else {
    recordBtn.classList.remove("recording");
    recordLabel.textContent = "Record";
    setStatus("connected", "Connected");
  }
}

function resetMetricsUI(): void {
  Object.values(cwvEls).forEach((el) => {
    el.textContent = "—";
    el.className = "metric-value null";
  });
  runtimeEls.longTasks.textContent = "—";
  runtimeEls.heap.textContent = "—";
  idleState.style.display = "flex";
  recordingState.style.display = "none";

  if (timelineCtx && timelineCanvas) {
    timelineCtx.clearRect(0, 0, timelineCanvas.width, timelineCanvas.height);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────────────────────────────────────

type StatusMode = "connecting" | "connected" | "recording" | "error";

function setStatus(mode: StatusMode, text: string): void {
  statusDot.className = `status-dot ${mode}`;
  statusText.textContent = text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service worker communication
// ─────────────────────────────────────────────────────────────────────────────

async function sendToServiceWorker<T>(
  type: ExtensionMessage["type"],
  payload: unknown
): Promise<T | null> {
  const msg: ExtensionMessage = {
    type,
    tabId: state.tabId,
    timestamp: Date.now(),
    payload,
  };

  try {
    return (await chrome.runtime.sendMessage(msg)) as T;
  } catch (err) {
    console.warn(`[panel] SW message failed (${type}):`, err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTimeline(): void {
  if (!timelineCanvas) return;
  const ctx = timelineCtx;
  if (!ctx) {
    return;
  }
  if (timelineHistory.length === 0) {
    timelineCtx.clearRect(0, 0, timelineCanvas.width, timelineCanvas.height);
    return;
  }

  const width = timelineCanvas!.width;
  const height = timelineCanvas!.height;

  ctx.clearRect(0, 0, width, height);

  // Padding for axes
  const paddingLeft = 30;
  const paddingRight = 10;
  const paddingTop = 10;
  const paddingBottom = 20;

  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const points = timelineHistory;
  const firstTs = points[0].timestamp;
  const lastTs = points[points.length - 1].timestamp;
  const span = Math.max(1000, lastTs - firstTs);

  // Compute value ranges for LCP/FCP (ms) and CLS (unitless, small)
  let maxMs = 0;
  let maxCls = 0;
  for (const p of points) {
    const { lcp, fcp, ttfb } = p.cwv;
    if (lcp !== null) maxMs = Math.max(maxMs, lcp);
    if (fcp !== null) maxMs = Math.max(maxMs, fcp);
    if (ttfb !== null) maxMs = Math.max(maxMs, ttfb);
    if (p.cwv.cls !== null) maxCls = Math.max(maxCls, p.cwv.cls);
  }
  if (maxMs === 0) maxMs = 1000;
  if (maxCls === 0) maxCls = 0.1;

  // Draw axes
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(paddingLeft, paddingTop);
  ctx.lineTo(paddingLeft, paddingTop + plotHeight);
  ctx.lineTo(paddingLeft + plotWidth, paddingTop + plotHeight);
  ctx.stroke();

  // Helper to map a timestamp/value to canvas coords
  const xForTs = (ts: number) =>
    paddingLeft + ((ts - firstTs) / span) * plotWidth;
  const yForMs = (v: number) =>
    paddingTop + plotHeight - (v / maxMs) * plotHeight * 0.7;
  const yForCls = (v: number) =>
    paddingTop + plotHeight - (v / maxCls) * plotHeight * 0.3;

  // Draw LCP (green)
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#3ddc84";
  ctx.beginPath();
  let first = true;
  for (const p of points) {
    if (p.cwv.lcp === null) continue;
    const x = xForTs(p.timestamp);
    const y = yForMs(p.cwv.lcp);
    if (first) {
      ctx.moveTo(x, y);
      first = false;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  // Draw FCP (blue)
  ctx.strokeStyle = "#4d9ef5";
  ctx.beginPath();
  first = true;
  for (const p of points) {
    if (p.cwv.fcp === null) continue;
    const x = xForTs(p.timestamp);
    const y = yForMs(p.cwv.fcp);
    if (first) {
      ctx.moveTo(x, y);
      first = false;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  // Draw CLS (amber), scaled separately near bottom
  ctx.strokeStyle = "#f5a623";
  ctx.beginPath();
  first = true;
  for (const p of points) {
    if (p.cwv.cls === null) continue;
    const x = xForTs(p.timestamp);
    const y = yForCls(p.cwv.cls);
    if (first) {
      ctx.moveTo(x, y);
      first = false;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => {
    console.error("[panel] Init failed:", err);
    setStatus("error", `Error: ${err}`);
  });
});
