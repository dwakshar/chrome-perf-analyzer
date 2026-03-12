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
/*!******************************************!*\
  !*** ./src/background/service-worker.ts ***!
  \******************************************/
__webpack_require__.r(__webpack_exports__);
/**
 * service-worker.ts
 *
 * MV3 Service Worker — the coordination hub of the extension.
 *
 * Responsibilities:
 *   • Receive DEVTOOLS_OPENED / DEVTOOLS_CLOSED lifecycle events
 *   • Attach / detach chrome.debugger to the inspected tab
 *   • Route CDP events to the appropriate Collector
 *   • Push processed metrics to the DevTools panel
 *   • Persist session state in chrome.storage.session (survives SW sleep)
 *
 * MV3 note: Service workers are ephemeral — they are killed after ~30s of
 * inactivity. ALL persistent state must live in chrome.storage.session, not
 * in module-level variables.
 */
// ─────────────────────────────────────────────────────────────────────────────
// In-memory registry (lives only while SW is active)
// ─────────────────────────────────────────────────────────────────────────────
/** Map of tabId → whether debugger is currently attached */
const attachedTabs = new Map();
/** Map of tabId → port connected to the panel (for push messages) */
const panelPorts = new Map();
// ─────────────────────────────────────────────────────────────────────────────
// Message routing
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
        .then(sendResponse)
        .catch((err) => {
        console.error("[sw] Message handler error:", err);
        sendResponse({ error: String(err) });
    });
    // Return true to keep the message channel open for async sendResponse.
    return true;
});
async function handleMessage(msg, sender) {
    const effectiveTabId = (msg.tabId && msg.tabId !== -1 ? msg.tabId : undefined) ??
        sender?.tab?.id;
    if (!effectiveTabId) {
        console.warn("[sw] Dropping message without tabId:", msg.type);
        return null;
    }
    // Normalise tabId so downstream handlers always have a concrete value.
    msg.tabId = effectiveTabId;
    console.log(`[sw] Received: ${msg.type} for tab ${effectiveTabId}`);
    switch (msg.type) {
        case "DEVTOOLS_OPENED":
            return onDevToolsOpened(msg);
        case "DEVTOOLS_CLOSED":
            return onDevToolsClosed(msg.tabId);
        case "PANEL_READY":
            return onPanelReady(msg.tabId);
        case "RECORDING_START":
            return onRecordingStart(effectiveTabId);
        case "RECORDING_STOP":
            return onRecordingStop(effectiveTabId);
        case "METRICS_UPDATE":
            return onMetricsUpdate(effectiveTabId, msg.payload);
        default:
            console.warn(`[sw] Unhandled message type: ${msg.type}`);
            return null;
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle handlers
// ─────────────────────────────────────────────────────────────────────────────
async function onDevToolsOpened(msg) {
    const { tabId, tabUrl, sessionId } = msg.payload;
    const key = `session:${tabId}`;
    const existing = (await chrome.storage.session.get(key))[key];
    // Persist session metadata in storage so it survives SW restarts while
    // preserving any metrics that might have been recorded before DevTools opened.
    await chrome.storage.session.set({
        [key]: {
            tabId,
            tabUrl,
            sessionId,
            recordingState: existing?.recordingState ?? "idle",
            openedAt: existing?.openedAt ?? Date.now(),
            metricsSnapshot: existing?.metricsSnapshot ?? null,
        },
    });
    // Attach debugger — enables CDP domains for this tab.
    await attachDebugger(tabId);
    console.log(`[sw] Session initialized for tab ${tabId} (${tabUrl})`);
    return { ok: true };
}
async function onDevToolsClosed(tabId) {
    await detachDebugger(tabId);
    await chrome.storage.session.remove(`session:${tabId}`);
    panelPorts.delete(tabId);
    console.log(`[sw] Cleaned up session for tab ${tabId}`);
}
async function onPanelReady(tabId) {
    // Re-hydrate panel with current session state after panel mounts / re-mounts.
    const stored = await chrome.storage.session.get(`session:${tabId}`);
    const session = stored[`session:${tabId}`];
    if (!session) {
        console.warn(`[sw] No session found for tab ${tabId} on PANEL_READY`);
        return null;
    }
    return {
        sessionId: session.sessionId,
        recordingState: session.recordingState,
        metricsSnapshot: session.metricsSnapshot ?? null,
    };
}
async function onRecordingStart(tabId) {
    await updateSessionState(tabId, { recordingState: "recording" });
    // Enable Performance Timeline via CDP.
    await sendCDPCommand(tabId, "Performance.enable", {
        timeDomain: "timeTicks",
    });
    // HeapProfiler is not available in all environments; failures here should not
    // cause the overall RECORDING_START handler to fail.
    try {
        await sendCDPCommand(tabId, "HeapProfiler.startTrackingHeapObjects", {
            trackAllocations: true,
        });
    }
    catch (err) {
        console.warn("[sw] HeapProfiler.startTrackingHeapObjects not available:", err);
    }
    console.log(`[sw] Recording started for tab ${tabId}`);
}
async function onRecordingStop(tabId) {
    await updateSessionState(tabId, { recordingState: "idle" });
    try {
        await sendCDPCommand(tabId, "HeapProfiler.stopTrackingHeapObjects");
    }
    catch (err) {
        console.warn("[sw] HeapProfiler.stopTrackingHeapObjects not available:", err);
    }
    console.log(`[sw] Recording stopped for tab ${tabId}`);
}
async function onMetricsUpdate(tabId, payload) {
    const snapshot = {
        cwv: payload.cwv,
        longTasks: [],
        networkRequests: [],
        heapTimeline: [],
        paintEvents: [],
        recordingStart: Date.now(),
    };
    await updateSessionState(tabId, { metricsSnapshot: snapshot });
    // Push raw metrics to the panel.
    pushToPanel(tabId, {
        type: "METRICS_UPDATE",
        tabId,
        timestamp: Date.now(),
        payload: snapshot,
    });
    // Derive a simple analysis result from CWV alone so the Issues panel has
    // something meaningful to display even before the deeper bundle analyzer is
    // wired up.
    const analysis = {
        issues: deriveIssuesFromCWV(snapshot.cwv),
        score: computeCwvScore(snapshot.cwv),
        recommendations: [],
        analyzedAt: Date.now(),
    };
    if (analysis.issues.length > 0) {
        pushToPanel(tabId, {
            type: "ANALYSIS_RESULT",
            tabId,
            timestamp: Date.now(),
            payload: analysis,
        });
    }
}
function deriveIssuesFromCWV(cwv) {
    const issues = [];
    const makeId = (suffix) => `cwv_${suffix}_${Date.now()}`;
    if (cwv.lcp !== null && cwv.lcp > 2500) {
        issues.push({
            id: makeId("lcp"),
            severity: cwv.lcp > 4000 ? "critical" : "warning",
            category: "rendering",
            title: `LCP is high (${Math.round(cwv.lcp)} ms)`,
            detail: "Largest Contentful Paint is slower than recommended. This often indicates heavy hero images or render-blocking resources.",
            recommendation: "Optimize above-the-fold images (compression, proper sizing, lazy-load offscreen) and reduce render-blocking CSS/JS.",
        });
    }
    if (cwv.cls !== null && cwv.cls > 0.1) {
        issues.push({
            id: makeId("cls"),
            severity: cwv.cls > 0.25 ? "critical" : "warning",
            category: "rendering",
            title: `CLS is high (${cwv.cls.toFixed(3)})`,
            detail: "Cumulative Layout Shift is above the recommended threshold, which means elements are moving around visibly during load.",
            recommendation: "Always reserve space for images/ads, avoid inserting content above existing content, and use transform-based animations.",
        });
    }
    if (cwv.fcp !== null && cwv.fcp > 1800) {
        issues.push({
            id: makeId("fcp"),
            severity: cwv.fcp > 3000 ? "warning" : "info",
            category: "rendering",
            title: `FCP is slow (${Math.round(cwv.fcp)} ms)`,
            detail: "First Contentful Paint is slower than recommended, indicating that the initial render is delayed.",
            recommendation: "Reduce critical JavaScript and CSS on the initial path and consider server-side rendering or static generation where possible.",
        });
    }
    if (cwv.ttfb !== null && cwv.ttfb > 800) {
        issues.push({
            id: makeId("ttfb"),
            severity: cwv.ttfb > 1800 ? "warning" : "info",
            category: "network",
            title: `TTFB is high (${Math.round(cwv.ttfb)} ms)`,
            detail: "Time To First Byte is slow, which usually points to backend latency or slow CDN/hosting.",
            recommendation: "Profile server response times, enable caching (CDN, edge), and optimize database or API calls on the critical path.",
        });
    }
    return issues;
}
function computeCwvScore(cwv) {
    // Very lightweight scoring: start from 100 and subtract penalties for each
    // metric that falls into 'needs-improvement' or 'poor' buckets.
    let score = 100;
    const penalize = (condition, mild, strong) => {
        if (!condition)
            return;
        score -= strong ?? mild;
    };
    if (cwv.lcp !== null) {
        if (cwv.lcp > 4000)
            score -= 25;
        else if (cwv.lcp > 2500)
            score -= 10;
    }
    if (cwv.cls !== null) {
        if (cwv.cls > 0.25)
            score -= 20;
        else if (cwv.cls > 0.1)
            score -= 8;
    }
    if (cwv.inp !== null) {
        if (cwv.inp > 500)
            score -= 20;
        else if (cwv.inp > 200)
            score -= 8;
    }
    if (cwv.fcp !== null) {
        if (cwv.fcp > 3000)
            score -= 10;
        else if (cwv.fcp > 1800)
            score -= 5;
    }
    if (cwv.ttfb !== null) {
        if (cwv.ttfb > 1800)
            score -= 10;
        else if (cwv.ttfb > 800)
            score -= 5;
    }
    return Math.max(0, Math.min(100, score));
}
// ─────────────────────────────────────────────────────────────────────────────
// CDP: Debugger attach / detach
// ─────────────────────────────────────────────────────────────────────────────
async function attachDebugger(tabId) {
    if (attachedTabs.get(tabId))
        return;
    try {
        await chrome.debugger.attach({ tabId }, "1.3");
        attachedTabs.set(tabId, true);
        // Enable core CDP domains.
        await Promise.all([
            sendCDPCommand(tabId, "Network.enable", { maxPostDataSize: 65_536 }),
            sendCDPCommand(tabId, "Runtime.enable"),
            sendCDPCommand(tabId, "Page.enable"),
        ]);
        console.log(`[sw] Debugger attached to tab ${tabId}`);
    }
    catch (err) {
        console.error(`[sw] Failed to attach debugger to tab ${tabId}:`, err);
        throw err;
    }
}
async function detachDebugger(tabId) {
    if (!attachedTabs.get(tabId))
        return;
    try {
        await chrome.debugger.detach({ tabId });
    }
    catch {
        // Tab may have already been closed.
    }
    finally {
        attachedTabs.delete(tabId);
    }
}
async function sendCDPCommand(tabId, method, params) {
    return chrome.debugger.sendCommand({ tabId }, method, params ?? {});
}
// ─────────────────────────────────────────────────────────────────────────────
// CDP event listener — route events to collectors
// ─────────────────────────────────────────────────────────────────────────────
chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (!tabId)
        return;
    routeCDPEvent(tabId, method, params);
});
function routeCDPEvent(tabId, method, params) {
    // Forward raw CDP event to the panel (if open) for display / recording.
    pushToPanel(tabId, {
        type: "CDP_EVENT",
        tabId,
        timestamp: Date.now(),
        payload: { method, params },
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Push messages to panel
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Send a message to the DevTools panel for this tab.
 * Uses chrome.runtime.sendMessage — the panel must have a listener registered.
 */
function pushToPanel(tabId, message) {
    chrome.runtime.sendMessage(message).catch(() => {
        // Panel may not be open — this is expected and not an error.
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────────────────────
async function updateSessionState(tabId, patch) {
    const key = `session:${tabId}`;
    const stored = await chrome.storage.session.get(key);
    const current = stored[key] ?? {};
    await chrome.storage.session.set({ [key]: { ...current, ...patch } });
}
// ─────────────────────────────────────────────────────────────────────────────
// Tab cleanup — detach debugger if tab is closed while DevTools is open
// ─────────────────────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
    if (attachedTabs.has(tabId)) {
        detachDebugger(tabId).catch(console.error);
        chrome.storage.session.remove(`session:${tabId}`).catch(console.error);
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// SW wake-up keepalive for long-running sessions
// ─────────────────────────────────────────────────────────────────────────────
if (typeof chrome.alarms !== "undefined") {
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === "perf-keepalive") {
            console.debug("[sw] Keepalive ping");
        }
    });
}
console.log("[sw] Service worker initialized");


/******/ })()
;
//# sourceMappingURL=service-worker.js.map