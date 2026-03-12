/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	// The require scope
/******/ 	var __webpack_require__ = {};
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
/*!****************************!*\
  !*** ./src/panel/panel.ts ***!
  \****************************/
__webpack_require__.r(__webpack_exports__);
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
const state = {
    tabId: -1,
    recording: false,
    sessionId: null,
    metricsSnapshot: null,
    issues: [],
};
// ─────────────────────────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const recordBtn = $("record-btn");
const recordLabel = $("record-label");
const clearBtn = $("clear-btn");
const sessionInfo = $("session-info");
const statusDot = $("status-dot");
const statusText = $("status-text");
const idleState = $("idle-state");
const recordingState = $("recording-state");
const issuesList = $("issues-list");
// CWV metric elements
const cwvEls = {
    lcp: $("lcp-value"),
    cls: $("cls-value"),
    inp: $("inp-value"),
    fcp: $("fcp-value"),
    ttfb: $("ttfb-value"),
};
const runtimeEls = {
    longTasks: $("long-tasks-value"),
    heap: $("heap-value"),
};
const timelineCanvas = $("timeline-canvas");
const timelineCtx = timelineCanvas?.getContext("2d") ?? null;
const timelineHistory = [];
// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
async function waitForTabId(timeoutMs = 5000) {
    const start = Date.now();
    // The devtools page sets __PERF_TAB_ID__ on the panel window from its
    // panel.onShown callback. Depending on load order this can race with our
    // DOMContentLoaded handler, so we poll briefly until it appears.
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const candidate = window
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
async function init() {
    state.tabId = await waitForTabId();
    setStatus("connecting", `Connecting to tab ${state.tabId}…`);
    sessionInfo.textContent = `Tab ${state.tabId}`;
    // Tell service worker we're ready — it will push back session state.
    const hydration = await sendToServiceWorker("PANEL_READY", null);
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
function applyHydration(hydration) {
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
function wireServiceWorkerMessages() {
    chrome.runtime.onMessage.addListener((message) => {
        // Lazily bind to the first tab that sends us data if we failed to
        // initialise from __PERF_TAB_ID__ for any reason.
        if (state.tabId === -1) {
            state.tabId = message.tabId;
            sessionInfo.textContent = `Tab ${state.tabId}`;
        }
        if (message.tabId !== state.tabId)
            return;
        switch (message.type) {
            case "METRICS_UPDATE":
                handleMetricsUpdate(message.payload);
                break;
            case "ANALYSIS_RESULT":
                handleAnalysisResult(message.payload);
                break;
            case "CDP_EVENT":
                // Raw CDP events — forwarded for timeline rendering (future).
                break;
        }
    });
}
function handleMetricsUpdate(snapshot) {
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
function handleAnalysisResult(result) {
    state.issues = result.issues;
    renderIssues(result.issues);
}
// ─────────────────────────────────────────────────────────────────────────────
// Controls
// ─────────────────────────────────────────────────────────────────────────────
function wireControls() {
    recordBtn.addEventListener("click", async () => {
        if (state.recording) {
            await sendToServiceWorker("RECORDING_STOP", null);
            state.recording = false;
        }
        else {
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
function renderMetrics(cwv) {
    updateMetricEl(cwvEls.lcp, cwv.lcp, "ms", [2500, 4000]);
    updateMetricEl(cwvEls.cls, cwv.cls, "", [0.1, 0.25], 3);
    updateMetricEl(cwvEls.inp, cwv.inp, "ms", [200, 500]);
    updateMetricEl(cwvEls.fcp, cwv.fcp, "ms", [1800, 3000]);
    updateMetricEl(cwvEls.ttfb, cwv.ttfb, "ms", [800, 1800]);
}
function updateMetricEl(el, value, unit, thresholds, decimals = 0) {
    if (value === null) {
        el.textContent = "—";
        el.className = "metric-value null";
        return;
    }
    const formatted = value.toFixed(decimals);
    el.innerHTML = `${formatted}<span class="metric-unit">${unit}</span>`;
    if (value <= thresholds[0])
        el.className = "metric-value good";
    else if (value <= thresholds[1])
        el.className = "metric-value needs-improvement";
    else
        el.className = "metric-value poor";
}
function renderRuntimeMetrics(snapshot) {
    // Long tasks count
    const ltCount = snapshot.longTasks.length;
    runtimeEls.longTasks.textContent = String(ltCount);
    runtimeEls.longTasks.className = `metric-value ${ltCount === 0 ? "good" : ltCount < 5 ? "needs-improvement" : "poor"}`;
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
function renderIssues(issues) {
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
        .map((issue) => `
    <div class="issue-item">
      <span class="issue-badge ${issue.severity}">${issue.severity}</span>
      <div>
        <div class="issue-title">${escapeHtml(issue.title)}</div>
        <div class="issue-detail">${escapeHtml(issue.detail)}</div>
      </div>
    </div>
  `)
        .join("");
}
function updateRecordUI() {
    if (state.recording) {
        recordBtn.classList.add("recording");
        recordLabel.textContent = "Stop";
        setStatus("recording", "Recording…");
        idleState.style.display = "none";
        recordingState.style.display = "block";
    }
    else {
        recordBtn.classList.remove("recording");
        recordLabel.textContent = "Record";
        setStatus("connected", "Connected");
    }
}
function resetMetricsUI() {
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
function setStatus(mode, text) {
    statusDot.className = `status-dot ${mode}`;
    statusText.textContent = text;
}
// ─────────────────────────────────────────────────────────────────────────────
// Service worker communication
// ─────────────────────────────────────────────────────────────────────────────
async function sendToServiceWorker(type, payload) {
    const msg = {
        type,
        tabId: state.tabId,
        timestamp: Date.now(),
        payload,
    };
    try {
        return (await chrome.runtime.sendMessage(msg));
    }
    catch (err) {
        console.warn(`[panel] SW message failed (${type}):`, err);
        return null;
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function renderTimeline() {
    if (!timelineCanvas)
        return;
    const ctx = timelineCtx;
    if (!ctx) {
        return;
    }
    if (timelineHistory.length === 0) {
        timelineCtx.clearRect(0, 0, timelineCanvas.width, timelineCanvas.height);
        return;
    }
    const width = timelineCanvas.width;
    const height = timelineCanvas.height;
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
        if (lcp !== null)
            maxMs = Math.max(maxMs, lcp);
        if (fcp !== null)
            maxMs = Math.max(maxMs, fcp);
        if (ttfb !== null)
            maxMs = Math.max(maxMs, ttfb);
        if (p.cwv.cls !== null)
            maxCls = Math.max(maxCls, p.cwv.cls);
    }
    if (maxMs === 0)
        maxMs = 1000;
    if (maxCls === 0)
        maxCls = 0.1;
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
    const xForTs = (ts) => paddingLeft + ((ts - firstTs) / span) * plotWidth;
    const yForMs = (v) => paddingTop + plotHeight - (v / maxMs) * plotHeight * 0.7;
    const yForCls = (v) => paddingTop + plotHeight - (v / maxCls) * plotHeight * 0.3;
    // Draw LCP (green)
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#3ddc84";
    ctx.beginPath();
    let first = true;
    for (const p of points) {
        if (p.cwv.lcp === null)
            continue;
        const x = xForTs(p.timestamp);
        const y = yForMs(p.cwv.lcp);
        if (first) {
            ctx.moveTo(x, y);
            first = false;
        }
        else {
            ctx.lineTo(x, y);
        }
    }
    ctx.stroke();
    // Draw FCP (blue)
    ctx.strokeStyle = "#4d9ef5";
    ctx.beginPath();
    first = true;
    for (const p of points) {
        if (p.cwv.fcp === null)
            continue;
        const x = xForTs(p.timestamp);
        const y = yForMs(p.cwv.fcp);
        if (first) {
            ctx.moveTo(x, y);
            first = false;
        }
        else {
            ctx.lineTo(x, y);
        }
    }
    ctx.stroke();
    // Draw CLS (amber), scaled separately near bottom
    ctx.strokeStyle = "#f5a623";
    ctx.beginPath();
    first = true;
    for (const p of points) {
        if (p.cwv.cls === null)
            continue;
        const x = xForTs(p.timestamp);
        const y = yForCls(p.cwv.cls);
        if (first) {
            ctx.moveTo(x, y);
            first = false;
        }
        else {
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


/******/ })()
;
//# sourceMappingURL=panel.js.map