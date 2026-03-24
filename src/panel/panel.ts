import type {
  AnalysisResultPayload,
  CoreWebVitals,
  ExtensionMessage,
  MetricsSnapshot,
  PerformanceIssue,
  SessionHydratePayload,
} from "../shared/types/messages.types.js";

interface PanelState {
  tabId: number;
  recording: boolean;
  sessionId: string | null;
  metricsSnapshot: MetricsSnapshot | null;
  issues: PerformanceIssue[];
}

interface TimelinePoint {
  timestamp: number;
  cwv: CoreWebVitals;
}

type StatusMode = "connecting" | "connected" | "recording" | "error";

interface CanvasMetrics {
  width: number;
  height: number;
  dpr: number;
}

const state: PanelState = {
  tabId: -1,
  recording: false,
  sessionId: null,
  metricsSnapshot: null,
  issues: [],
};

const timelineHistory: TimelinePoint[] = [];

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
const timelineCanvas = $<HTMLCanvasElement>("timeline-canvas");
const runtimeCanvas = $<HTMLCanvasElement>("runtime-canvas");
const healthCanvas = $<HTMLCanvasElement>("health-canvas");
const radarCanvas = $<HTMLCanvasElement>("radar-canvas");
const timelineCtx = timelineCanvas.getContext("2d");
const runtimeCtx = runtimeCanvas.getContext("2d");
const healthCtx = healthCanvas.getContext("2d");
const radarCtx = radarCanvas.getContext("2d");

const vitalsCaption = $<HTMLSpanElement>("vitals-caption");
const runtimeCaption = $<HTMLSpanElement>("runtime-caption");
const healthCaption = $<HTMLSpanElement>("health-caption");
const radarCaption = $<HTMLSpanElement>("radar-caption");

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

let resizeQueued = false;

async function waitForTabId(timeoutMs = 5000): Promise<number> {
  const startedAt = Date.now();

  while (true) {
    const tabId = (window as Window & { __PERF_TAB_ID__?: number })
      .__PERF_TAB_ID__;

    if (typeof tabId === "number" && tabId >= 0) {
      return tabId;
    }

    if (Date.now() - startedAt > timeoutMs) {
      return -1;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function init(): Promise<void> {
  state.tabId = await waitForTabId();
  syncAllCanvasResolutions();

  setStatus("connecting", `Connecting to tab ${state.tabId}...`);
  sessionInfo.textContent = `Tab ${state.tabId}`;

  const hydration = await sendToServiceWorker<SessionHydratePayload>(
    "PANEL_READY",
    null
  );

  if (hydration) {
    applyHydration(hydration);
  } else {
    resetMetricsUI();
    renderIssues([]);
  }

  wireControls();
  wireServiceWorkerMessages();
  wireResponsiveCharts();
  setStatus("connected", "Connected");
}

function applyHydration(hydration: SessionHydratePayload): void {
  state.sessionId = hydration.sessionId;
  state.recording = hydration.recordingState === "recording";
  state.metricsSnapshot = hydration.metricsSnapshot;
  state.issues = hydration.analysisSnapshot?.issues ?? [];

  if (hydration.metricsSnapshot) {
    timelineHistory.length = 0;
    timelineHistory.push({
      timestamp: hydration.metricsSnapshot.recordingStart,
      cwv: hydration.metricsSnapshot.cwv,
    });
    renderMetrics(hydration.metricsSnapshot.cwv);
    renderRuntimeMetrics(hydration.metricsSnapshot);
    renderChartsAndSummary(hydration.metricsSnapshot);
  } else {
    timelineHistory.length = 0;
    resetMetricsUI();
  }

  renderIssues(state.issues);
  updateRecordUI();
}

function wireServiceWorkerMessages(): void {
  chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
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
      default:
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

  if (timelineHistory.length > 180) {
    timelineHistory.splice(0, timelineHistory.length - 180);
  }

  renderMetrics(snapshot.cwv);
  renderRuntimeMetrics(snapshot);
  renderChartsAndSummary(snapshot);
}

function handleAnalysisResult(result: AnalysisResultPayload): void {
  state.issues = result.issues;
  renderIssues(result.issues);
}

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

  clearBtn.addEventListener("click", async () => {
    await sendToServiceWorker("CLEAR_SESSION", null);
    state.recording = false;
    state.metricsSnapshot = null;
    state.issues = [];
    timelineHistory.length = 0;
    resetMetricsUI();
    renderIssues([]);
    updateRecordUI();
    setStatus("connected", "Session cleared");
  });
}

function wireResponsiveCharts(): void {
  window.addEventListener("resize", queueChartRedraw);
}

function queueChartRedraw(): void {
  if (resizeQueued) return;

  resizeQueued = true;
  window.requestAnimationFrame(() => {
    resizeQueued = false;
    syncAllCanvasResolutions();

    if (state.metricsSnapshot) {
      renderChartsAndSummary(state.metricsSnapshot);
    } else {
      resetMetricsUI();
    }
  });
}

function renderMetrics(cwv: CoreWebVitals): void {
  updateMetricEl(cwvEls.lcp, cwv.lcp, "ms", [2500, 4000]);
  updateMetricEl(cwvEls.cls, cwv.cls, "", [0.1, 0.25], 3);
  updateMetricEl(cwvEls.inp, cwv.inp, "ms", [200, 500]);
  updateMetricEl(cwvEls.fcp, cwv.fcp, "ms", [1800, 3000]);
  updateMetricEl(cwvEls.ttfb, cwv.ttfb, "ms", [800, 1800]);
}

function updateMetricEl(
  element: HTMLSpanElement,
  value: number | null,
  unit: string,
  thresholds: [number, number],
  decimals = 0
): void {
  if (value === null) {
    element.textContent = "-";
    element.className = "metric-value null";
    return;
  }

  element.innerHTML = `${value.toFixed(decimals)}<span class="metric-unit">${unit}</span>`;

  if (value <= thresholds[0]) {
    element.className = "metric-value good";
  } else if (value <= thresholds[1]) {
    element.className = "metric-value needs-improvement";
  } else {
    element.className = "metric-value poor";
  }
}

function renderRuntimeMetrics(snapshot: MetricsSnapshot): void {
  const longTaskCount = snapshot.longTasks.length;
  runtimeEls.longTasks.textContent = String(longTaskCount);
  runtimeEls.longTasks.className = `metric-value ${
    longTaskCount === 0
      ? "good"
      : longTaskCount < 5
        ? "needs-improvement"
        : "poor"
  }`;

  const latestHeap = snapshot.heapTimeline.at(-1);
  if (latestHeap) {
    const heapInMb = (latestHeap.usedJSHeapSize / 1_048_576).toFixed(1);
    runtimeEls.heap.innerHTML = `${heapInMb}<span class="metric-unit">MB</span>`;
    runtimeEls.heap.className = "metric-value";
  } else {
    runtimeEls.heap.textContent = "-";
    runtimeEls.heap.className = "metric-value null";
  }

  idleState.style.display = "none";
  recordingState.style.display = "block";
}

function renderChartsAndSummary(snapshot: MetricsSnapshot): void {
  syncAllCanvasResolutions();
  renderTimeline();
  renderRuntimeChart(snapshot);
  renderHealthBars(snapshot.cwv);
  renderRadarChart(snapshot.cwv);
  const hasTrend = timelineHistory.length > 1;
  const hasRuntime = snapshot.longTasks.length > 0 || snapshot.heapTimeline.length > 0;
  vitalsCaption.textContent = hasTrend
    ? "Observed trend across the session"
    : "Waiting for trend history";
  runtimeCaption.textContent = hasRuntime
    ? "Main-thread pressure and memory trend"
    : "Waiting for runtime samples";
  healthCaption.textContent = hasAnyMetric(snapshot.cwv)
    ? "Latest observed metric posture"
    : "Waiting for latest values";
  radarCaption.textContent = hasAnyMetric(snapshot.cwv)
    ? "Overall balance of the latest snapshot"
    : "Waiting for latest values";
}

function renderIssues(issues: PerformanceIssue[]): void {
  if (issues.length === 0) {
    issuesList.innerHTML =
      '<div class="issue-item" style="color:var(--text-dim); font-size:11px; font-family:var(--font-mono);">No issues detected yet.</div>';
    return;
  }

  const severityOrder = { critical: 0, warning: 1, info: 2 };
  const sorted = [...issues].sort(
    (left, right) => severityOrder[left.severity] - severityOrder[right.severity]
  );

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
    setStatus("recording", "Recording...");
    idleState.style.display = "none";
    recordingState.style.display = "block";
    return;
  }

  recordBtn.classList.remove("recording");
  recordLabel.textContent = "Record";

  if (!state.metricsSnapshot) {
    idleState.style.display = "flex";
    recordingState.style.display = "none";
  }
}

function resetMetricsUI(): void {
  for (const element of Object.values(cwvEls)) {
    element.textContent = "-";
    element.className = "metric-value null";
  }

  runtimeEls.longTasks.textContent = "-";
  runtimeEls.longTasks.className = "metric-value null";
  runtimeEls.heap.textContent = "-";
  runtimeEls.heap.className = "metric-value null";

  vitalsCaption.textContent = "LCP, FCP, and CLS over time";
  runtimeCaption.textContent = "Long tasks and heap samples";
  healthCaption.textContent = "Latest observed metric posture";
  radarCaption.textContent = "Overall balance of the latest snapshot";

  idleState.style.display = "flex";
  recordingState.style.display = "none";

  if (timelineCtx) {
    timelineCtx.clearRect(0, 0, timelineCanvas.width, timelineCanvas.height);
  }
  if (runtimeCtx) {
    runtimeCtx.clearRect(0, 0, runtimeCanvas.width, runtimeCanvas.height);
  }
  if (healthCtx) {
    healthCtx.clearRect(0, 0, healthCanvas.width, healthCanvas.height);
  }
  if (radarCtx) {
    radarCtx.clearRect(0, 0, radarCanvas.width, radarCanvas.height);
  }
}

function setStatus(mode: StatusMode, text: string): void {
  statusDot.className = `status-dot ${mode}`;
  statusText.textContent = text;
}

async function sendToServiceWorker<T>(
  type: ExtensionMessage["type"],
  payload: unknown
): Promise<T | null> {
  const message: ExtensionMessage = {
    type,
    tabId: state.tabId,
    timestamp: Date.now(),
    payload,
  };

  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch (error) {
    console.warn(`[panel] SW message failed (${type}):`, error);
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTimeline(): void {
  if (!timelineCtx) return;

  const { width, height } = getCanvasMetrics(timelineCanvas);
  const paddingLeft = 44;
  const paddingRight = 14;
  const paddingTop = 14;
  const paddingBottom = 26;

  timelineCtx.clearRect(0, 0, width, height);
  drawChartFrame(timelineCtx, width, height, paddingLeft, paddingTop, paddingRight, paddingBottom);

  if (timelineHistory.length === 0) {
    drawCenteredEmptyState(
      timelineCtx,
      width,
      height,
      "Waiting for observed vitals from the page"
    );
    return;
  }

  const firstPoint = timelineHistory[0]!;
  const lastPoint = timelineHistory[timelineHistory.length - 1]!;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;
  const span = Math.max(1000, lastPoint.timestamp - firstPoint.timestamp);

  let maxMs = 1000;
  let maxCls = 0.1;
  for (const point of timelineHistory) {
    const { lcp, fcp, inp, cls } = point.cwv;
    if (lcp !== null) maxMs = Math.max(maxMs, lcp);
    if (fcp !== null) maxMs = Math.max(maxMs, fcp);
    if (inp !== null) maxMs = Math.max(maxMs, inp);
    if (cls !== null) maxCls = Math.max(maxCls, cls);
  }

  const xForTimestamp = (timestamp: number) =>
    paddingLeft + ((timestamp - firstPoint.timestamp) / span) * plotWidth;
  const yForMs = (value: number) =>
    paddingTop + plotHeight - (value / maxMs) * plotHeight * 0.76;
  const yForCls = (value: number) =>
    paddingTop + plotHeight - (value / maxCls) * plotHeight * 0.24;

  drawThresholdBand(
    timelineCtx,
    paddingLeft,
    paddingTop,
    plotWidth,
    plotHeight,
    0,
    2500,
    maxMs,
    "rgba(61, 220, 132, 0.08)"
  );
  drawThresholdBand(
    timelineCtx,
    paddingLeft,
    paddingTop,
    plotWidth,
    plotHeight,
    2500,
    4000,
    maxMs,
    "rgba(245, 166, 35, 0.07)"
  );
  drawThresholdBand(
    timelineCtx,
    paddingLeft,
    paddingTop,
    plotWidth,
    plotHeight,
    4000,
    maxMs,
    maxMs,
    "rgba(255, 95, 95, 0.06)"
  );

  drawThresholdBand(
    timelineCtx,
    paddingLeft,
    paddingTop + plotHeight * 0.76,
    plotWidth,
    plotHeight * 0.24,
    0,
    0.1,
    maxCls,
    "rgba(61, 220, 132, 0.06)"
  );
  drawThresholdBand(
    timelineCtx,
    paddingLeft,
    paddingTop + plotHeight * 0.76,
    plotWidth,
    plotHeight * 0.24,
    0.1,
    0.25,
    maxCls,
    "rgba(245, 166, 35, 0.05)"
  );
  drawThresholdBand(
    timelineCtx,
    paddingLeft,
    paddingTop + plotHeight * 0.76,
    plotWidth,
    plotHeight * 0.24,
    0.25,
    maxCls,
    maxCls,
    "rgba(255, 95, 95, 0.04)"
  );

  drawAxisLabel(timelineCtx, `${Math.round(maxMs)} ms`, 6, paddingTop + 4);
  drawAxisLabel(timelineCtx, `${maxCls.toFixed(2)} cls`, 6, paddingTop + plotHeight * 0.8);
  drawTimeMarkers(
    timelineCtx,
    paddingLeft,
    paddingTop + plotHeight + 14,
    plotWidth,
    firstPoint.timestamp,
    lastPoint.timestamp
  );

  drawLine(timelineCtx, "#3ddc84", (point) => point.cwv.lcp, yForMs, xForTimestamp);
  drawLine(timelineCtx, "#4d9ef5", (point) => point.cwv.fcp, yForMs, xForTimestamp);
  drawLine(timelineCtx, "#57d3ff", (point) => point.cwv.inp, yForMs, xForTimestamp);
  drawLine(timelineCtx, "#f5a623", (point) => point.cwv.cls, yForCls, xForTimestamp);
}

function renderRuntimeChart(snapshot: MetricsSnapshot): void {
  if (!runtimeCtx) return;

  const { width, height } = getCanvasMetrics(runtimeCanvas);
  const paddingLeft = 32;
  const paddingRight = 10;
  const paddingTop = 14;
  const paddingBottom = 22;

  runtimeCtx.clearRect(0, 0, width, height);
  drawChartFrame(runtimeCtx, width, height, paddingLeft, paddingTop, paddingRight, paddingBottom);

  const longTasks = snapshot.longTasks.slice(-24);
  const heapSamples = snapshot.heapTimeline.slice(-24);

  if (longTasks.length === 0 && heapSamples.length === 0) {
    drawCenteredEmptyState(
      runtimeCtx,
      width,
      height,
      "Long tasks and heap samples will appear here"
    );
    return;
  }

  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  if (longTasks.length > 0) {
    const maxTask = Math.max(...longTasks.map((task) => task.duration), 50);
    const barWidth = plotWidth / Math.max(longTasks.length, 1);

    runtimeCtx.fillStyle = "rgba(245, 166, 35, 0.7)";
    longTasks.forEach((task, index) => {
      const x = paddingLeft + index * barWidth + 1;
      const barHeight = (task.duration / maxTask) * plotHeight * 0.72;
      runtimeCtx.fillRect(
        x,
        paddingTop + plotHeight - barHeight,
        Math.max(3, barWidth - 3),
        barHeight
      );
    });

    drawAxisLabel(runtimeCtx, `${Math.round(maxTask)} ms`, 4, paddingTop + 2);
    drawAxisLabel(runtimeCtx, "long task bars", width - 92, paddingTop + 2);
  }

  if (heapSamples.length > 1) {
    const maxHeap = Math.max(...heapSamples.map((sample) => sample.usedJSHeapSize));
    const minHeap = Math.min(...heapSamples.map((sample) => sample.usedJSHeapSize));
    const heapRange = Math.max(maxHeap - minHeap, 1);

    runtimeCtx.strokeStyle = "#57d3ff";
    runtimeCtx.lineWidth = 2;
    runtimeCtx.beginPath();

    heapSamples.forEach((sample, index) => {
      const x =
        paddingLeft +
        (index / Math.max(heapSamples.length - 1, 1)) * plotWidth;
      const normalized = (sample.usedJSHeapSize - minHeap) / heapRange;
      const y = paddingTop + plotHeight - normalized * plotHeight * 0.9;

      if (index === 0) {
        runtimeCtx.moveTo(x, y);
      } else {
        runtimeCtx.lineTo(x, y);
      }
    });

    runtimeCtx.stroke();
    drawAxisLabel(runtimeCtx, `${(maxHeap / 1_048_576).toFixed(1)} MB`, 4, paddingTop + 14);
    drawAxisLabel(runtimeCtx, "heap line", width - 58, paddingTop + 14);
  }
}

function renderHealthBars(cwv: CoreWebVitals): void {
  if (!healthCtx) return;

  const { width, height } = getCanvasMetrics(healthCanvas);
  healthCtx.clearRect(0, 0, width, height);
  drawChartFrame(healthCtx, width, height, 96, 18, 16, 22);

  const metrics: Array<{
    label: string;
    value: number | null;
    thresholds: [number, number];
    max: number;
    formatter: (value: number) => string;
  }> = [
    { label: "LCP", value: cwv.lcp, thresholds: [2500, 4000], max: 6000, formatter: (value) => `${Math.round(value)} ms` },
    { label: "CLS", value: cwv.cls, thresholds: [0.1, 0.25], max: 0.35, formatter: (value) => value.toFixed(3) },
    { label: "INP", value: cwv.inp, thresholds: [200, 500], max: 800, formatter: (value) => `${Math.round(value)} ms` },
    { label: "FCP", value: cwv.fcp, thresholds: [1800, 3000], max: 4500, formatter: (value) => `${Math.round(value)} ms` },
    { label: "TTFB", value: cwv.ttfb, thresholds: [800, 1800], max: 2500, formatter: (value) => `${Math.round(value)} ms` },
  ];

  const startX = 108;
  const endX = width - 22;
  const barWidth = endX - startX;
  const rowHeight = 42;
  const top = 30;

  metrics.forEach((metric, index) => {
    const y = top + index * rowHeight;
    const scale = (value: number) => startX + (Math.min(value, metric.max) / metric.max) * barWidth;

    healthCtx.fillStyle = "rgba(61, 220, 132, 0.18)";
    healthCtx.fillRect(startX, y, scale(metric.thresholds[0]) - startX, 14);
    healthCtx.fillStyle = "rgba(245, 166, 35, 0.18)";
    healthCtx.fillRect(scale(metric.thresholds[0]), y, scale(metric.thresholds[1]) - scale(metric.thresholds[0]), 14);
    healthCtx.fillStyle = "rgba(255, 95, 95, 0.18)";
    healthCtx.fillRect(scale(metric.thresholds[1]), y, endX - scale(metric.thresholds[1]), 14);

    healthCtx.fillStyle = "rgba(255,255,255,0.72)";
    healthCtx.font = '11px "JetBrains Mono", monospace';
    healthCtx.textAlign = "left";
    healthCtx.fillText(metric.label, 18, y + 11);

    if (metric.value !== null) {
      const markerX = scale(metric.value);
      healthCtx.fillStyle = colorForMetric(metric.value, metric.thresholds);
      healthCtx.beginPath();
      healthCtx.arc(markerX, y + 7, 6, 0, Math.PI * 2);
      healthCtx.fill();

      healthCtx.fillStyle = "rgba(255,255,255,0.56)";
      healthCtx.font = '10px "IBM Plex Sans", sans-serif';
      healthCtx.fillText(metric.formatter(metric.value), startX, y + 31);
    } else {
      healthCtx.fillStyle = "rgba(255,255,255,0.28)";
      healthCtx.font = '10px "IBM Plex Sans", sans-serif';
      healthCtx.fillText("Waiting for data", startX, y + 31);
    }
  });
}

function renderRadarChart(cwv: CoreWebVitals): void {
  if (!radarCtx) return;

  const { width, height } = getCanvasMetrics(radarCanvas);
  radarCtx.clearRect(0, 0, width, height);

  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.28;
  const axes = [
    { label: "LCP", score: scoreMetric(cwv.lcp, [2500, 4000], 6000) },
    { label: "CLS", score: scoreMetric(cwv.cls, [0.1, 0.25], 0.35) },
    { label: "INP", score: scoreMetric(cwv.inp, [200, 500], 800) },
    { label: "FCP", score: scoreMetric(cwv.fcp, [1800, 3000], 4500) },
    { label: "TTFB", score: scoreMetric(cwv.ttfb, [800, 1800], 2500) },
  ];

  radarCtx.save();
  radarCtx.strokeStyle = "rgba(255,255,255,0.08)";
  radarCtx.lineWidth = 1;

  for (let ring = 1; ring <= 4; ring += 1) {
    const ringRadius = (radius / 4) * ring;
    radarCtx.beginPath();
    axes.forEach((_, index) => {
      const point = polarPoint(centerX, centerY, ringRadius, index, axes.length);
      if (index === 0) radarCtx.moveTo(point.x, point.y);
      else radarCtx.lineTo(point.x, point.y);
    });
    radarCtx.closePath();
    radarCtx.stroke();
  }

  axes.forEach((axis, index) => {
    const point = polarPoint(centerX, centerY, radius, index, axes.length);
    radarCtx.beginPath();
    radarCtx.moveTo(centerX, centerY);
    radarCtx.lineTo(point.x, point.y);
    radarCtx.stroke();

    radarCtx.fillStyle = "rgba(255,255,255,0.54)";
    radarCtx.font = '10px "JetBrains Mono", monospace';
    radarCtx.textAlign = point.x >= centerX ? "left" : "right";
    radarCtx.fillText(axis.label, point.x + (point.x >= centerX ? 8 : -8), point.y);
  });

  if (axes.some((axis) => axis.score !== null)) {
    radarCtx.beginPath();
    axes.forEach((axis, index) => {
      const point = polarPoint(
        centerX,
        centerY,
        radius * (axis.score ?? 0.12),
        index,
        axes.length
      );
      if (index === 0) radarCtx.moveTo(point.x, point.y);
      else radarCtx.lineTo(point.x, point.y);
    });
    radarCtx.closePath();
    radarCtx.fillStyle = "rgba(87, 211, 255, 0.18)";
    radarCtx.strokeStyle = "rgba(87, 211, 255, 0.82)";
    radarCtx.lineWidth = 2;
    radarCtx.fill();
    radarCtx.stroke();
  } else {
    drawCenteredEmptyState(radarCtx, width, height, "Waiting for enough metric data");
  }

  radarCtx.restore();
}

function drawChartFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  paddingLeft: number,
  paddingTop: number,
  paddingRight: number,
  paddingBottom: number
): void {
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;

  for (let row = 0; row <= 4; row += 1) {
    const y = paddingTop + (plotHeight / 4) * row;
    ctx.beginPath();
    ctx.moveTo(paddingLeft, y);
    ctx.lineTo(paddingLeft + plotWidth, y);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.moveTo(paddingLeft, paddingTop);
  ctx.lineTo(paddingLeft, paddingTop + plotHeight);
  ctx.lineTo(paddingLeft + plotWidth, paddingTop + plotHeight);
  ctx.stroke();
  ctx.restore();
}

function drawThresholdBand(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
  from: number,
  to: number,
  domainMax: number,
  color: string
): void {
  if (domainMax <= 0 || to <= from) return;

  const start = Math.min(from / domainMax, 1);
  const end = Math.min(to / domainMax, 1);
  const bandHeight = (end - start) * height;
  const y = top + height - end * height;

  ctx.save();
  ctx.fillStyle = color;
  ctx.fillRect(left, y, width, bandHeight);
  ctx.restore();
}

function drawTimeMarkers(
  ctx: CanvasRenderingContext2D,
  left: number,
  y: number,
  width: number,
  firstTimestamp: number,
  lastTimestamp: number
): void {
  const span = Math.max(lastTimestamp - firstTimestamp, 1);
  const markers = 4;

  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.38)";
  ctx.font = '10px "JetBrains Mono", monospace';

  for (let index = 0; index <= markers; index += 1) {
    const ratio = index / markers;
    const x = left + width * ratio;
    const offsetMs = span * ratio;
    const label = `+${formatDurationLabel(offsetMs)}`;
    ctx.textAlign =
      index === 0 ? "left" : index === markers ? "right" : "center";
    ctx.fillText(label, x, y);
  }

  ctx.restore();
}

function drawCenteredEmptyState(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  label: string
): void {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.28)";
  ctx.font = '12px "IBM Plex Sans", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(label, width / 2, height / 2);
  ctx.restore();
}

function drawAxisLabel(
  ctx: CanvasRenderingContext2D,
  label: string,
  x: number,
  y: number
): void {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textAlign = "left";
  ctx.fillText(label, x, y);
  ctx.restore();
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  color: string,
  getValue: (point: TimelinePoint) => number | null,
  yForValue: (value: number) => number,
  xForTimestamp: (timestamp: number) => number
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();

  let started = false;
  for (const point of timelineHistory) {
    const value = getValue(point);
    if (value === null) continue;

    const x = xForTimestamp(point.timestamp);
    const y = yForValue(value);

    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();
  ctx.restore();
}

function polarPoint(
  centerX: number,
  centerY: number,
  radius: number,
  index: number,
  total: number
): { x: number; y: number } {
  const angle = -Math.PI / 2 + (index / total) * Math.PI * 2;
  return {
    x: centerX + Math.cos(angle) * radius,
    y: centerY + Math.sin(angle) * radius,
  };
}

function syncAllCanvasResolutions(): void {
  syncCanvasResolution(timelineCanvas, timelineCtx);
  syncCanvasResolution(runtimeCanvas, runtimeCtx);
  syncCanvasResolution(healthCanvas, healthCtx);
  syncCanvasResolution(radarCanvas, radarCtx);
}

function syncCanvasResolution(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D | null
): void {
  if (!ctx) return;

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cssWidth = Math.max(280, Math.round(canvas.getBoundingClientRect().width || canvas.width));
  const cssHeight = Math.max(220, Math.round(canvas.getBoundingClientRect().height || canvas.height));
  const nextWidth = Math.round(cssWidth * dpr);
  const nextHeight = Math.round(cssHeight * dpr);

  if (canvas.width === nextWidth && canvas.height === nextHeight) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return;
  }

  canvas.width = nextWidth;
  canvas.height = nextHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function getCanvasMetrics(canvas: HTMLCanvasElement): CanvasMetrics {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  return {
    width: canvas.width / dpr,
    height: canvas.height / dpr,
    dpr,
  };
}

function colorForMetric(
  value: number,
  thresholds: [number, number]
): string {
  if (value <= thresholds[0]) return "#3ddc84";
  if (value <= thresholds[1]) return "#f5a623";
  return "#ff5f5f";
}

function scoreMetric(
  value: number | null,
  thresholds: [number, number],
  max: number
): number | null {
  if (value === null) return null;
  const clamped = Math.min(value, max);
  if (clamped <= thresholds[0]) {
    return 1 - (clamped / thresholds[0]) * 0.22;
  }
  if (clamped <= thresholds[1]) {
    const range = thresholds[1] - thresholds[0];
    return 0.78 - ((clamped - thresholds[0]) / range) * 0.33;
  }
  const poorRange = Math.max(max - thresholds[1], 1);
  return Math.max(0.14, 0.45 - ((clamped - thresholds[1]) / poorRange) * 0.31);
}

function hasAnyMetric(cwv: CoreWebVitals): boolean {
  return [cwv.lcp, cwv.cls, cwv.inp, cwv.fcp, cwv.ttfb].some(
    (value) => value !== null
  );
}

function formatDurationLabel(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }

  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }

  return `${(durationMs / 60_000).toFixed(1)}m`;
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => {
    console.error("[panel] Init failed:", error);
    setStatus("error", `Error: ${error}`);
  });
});
