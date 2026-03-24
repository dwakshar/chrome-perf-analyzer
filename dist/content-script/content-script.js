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
/*!**********************************************!*\
  !*** ./src/content-script/content-script.ts ***!
  \**********************************************/
__webpack_require__.r(__webpack_exports__);
const tabId = -1;
const MAX_LONG_TASKS = 50;
const MAX_HEAP_SAMPLES = 60;
const HEAP_SAMPLE_INTERVAL_MS = 5000;
const MAX_INTERACTION_SAMPLES = 200;
const EVENT_OBSERVER_DURATION_THRESHOLD_MS = 40;
const INP_EVENT_WHITELIST = new Set([
    "click",
    "mousedown",
    "mouseup",
    "pointerdown",
    "pointerup",
    "keydown",
    "keyup",
    "touchstart",
    "touchend",
]);
const vitals = {};
const longTasks = [];
const heapTimeline = [];
const interactionLatencies = new Map();
let flushTimer = null;
let heapSampleTimer = null;
const hasPerformanceObserver = typeof PerformanceObserver !== "undefined";
const supportedEntryTypes = hasPerformanceObserver &&
    Array.isArray(PerformanceObserver.supportedEntryTypes)
    ? PerformanceObserver.supportedEntryTypes
    : [];
function canObserve(type) {
    if (!hasPerformanceObserver)
        return false;
    if (supportedEntryTypes.length === 0)
        return true;
    return supportedEntryTypes.includes(type);
}
function observe(type, callback) {
    if (!canObserve(type))
        return;
    try {
        const observer = new PerformanceObserver(callback);
        if (type === "event") {
            observer.observe({
                type,
                buffered: true,
                durationThreshold: EVENT_OBSERVER_DURATION_THRESHOLD_MS,
            });
            return;
        }
        observer.observe({ type, buffered: true });
    }
    catch {
        // Unsupported in this context.
    }
}
observe("largest-contentful-paint", (list) => {
    const entries = list.getEntries();
    const lastEntry = entries.at(-1);
    if (!lastEntry)
        return;
    vitals.lcp = lastEntry.startTime;
    scheduleFlush();
});
observe("layout-shift", (list) => {
    let cls = vitals.cls ?? 0;
    for (const entry of list.getEntries()) {
        const layoutShift = entry;
        if (!layoutShift.hadRecentInput) {
            cls += layoutShift.value;
        }
    }
    vitals.cls = cls;
    scheduleFlush();
});
if (canObserve("paint")) {
    try {
        const observer = new PerformanceObserver((list) => {
            const entry = list.getEntriesByName("first-contentful-paint")[0];
            if (!entry)
                return;
            vitals.fcp = entry.startTime;
            scheduleFlush();
        });
        observer.observe({ type: "paint", buffered: true });
    }
    catch {
        // Unsupported in this context.
    }
}
observe("event", (list) => {
    for (const entry of list.getEntries()) {
        const eventEntry = entry;
        if (!isInpCandidate(eventEntry))
            continue;
        const currentLatency = interactionLatencies.get(eventEntry.interactionId) ?? 0;
        interactionLatencies.set(eventEntry.interactionId, Math.max(currentLatency, eventEntry.duration));
    }
    pruneInteractionLatencies();
    const observedInp = computeObservedInp();
    if (observedInp !== null) {
        vitals.inp = observedInp;
        scheduleFlush();
    }
});
observe("longtask", (list) => {
    for (const entry of list.getEntries()) {
        const longTaskEntry = entry;
        const attribution = longTaskEntry.attribution?.[0];
        const longTask = {
            startTime: longTaskEntry.startTime,
            duration: longTaskEntry.duration,
        };
        if (attribution?.scriptUrl) {
            longTask.scriptUrl = attribution.scriptUrl;
        }
        const functionName = attribution?.functionName ?? attribution?.name;
        if (functionName) {
            longTask.functionName = functionName;
        }
        longTasks.push(longTask);
    }
    trimArray(longTasks, MAX_LONG_TASKS);
    scheduleFlush();
});
window.addEventListener("load", () => {
    const navigationEntry = performance.getEntriesByType("navigation")[0];
    if (navigationEntry) {
        vitals.ttfb = navigationEntry.responseStart - navigationEntry.requestStart;
    }
    sampleHeap();
    startHeapSampling();
    scheduleFlush();
}, { once: true });
window.addEventListener("pagehide", () => {
    stopHeapSampling();
    finalizeInp();
    flushMetrics();
}, { once: true });
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden")
        return;
    finalizeInp();
    flushMetrics();
});
function startHeapSampling() {
    if (heapSampleTimer !== null)
        return;
    heapSampleTimer = window.setInterval(() => {
        sampleHeap();
        scheduleFlush();
    }, HEAP_SAMPLE_INTERVAL_MS);
}
function stopHeapSampling() {
    if (heapSampleTimer === null)
        return;
    window.clearInterval(heapSampleTimer);
    heapSampleTimer = null;
}
function sampleHeap() {
    const memory = performance.memory;
    if (!memory)
        return;
    heapTimeline.push({
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        timestamp: Date.now(),
    });
    trimArray(heapTimeline, MAX_HEAP_SAMPLES);
}
function computeObservedInp() {
    const sortedLatencies = Array.from(interactionLatencies.values()).sort((left, right) => right - left);
    if (sortedLatencies.length === 0) {
        return null;
    }
    // Mirror the standard "ignore one worst interaction per 50" rule.
    const ignoredCount = Math.min(Math.floor(sortedLatencies.length / 50), Math.max(0, sortedLatencies.length - 1));
    return sortedLatencies[ignoredCount] ?? sortedLatencies[0] ?? null;
}
function finalizeInp() {
    const observedInp = computeObservedInp();
    if (observedInp !== null) {
        vitals.inp = observedInp;
    }
}
function pruneInteractionLatencies() {
    if (interactionLatencies.size <= MAX_INTERACTION_SAMPLES) {
        return;
    }
    const retainedEntries = Array.from(interactionLatencies.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, MAX_INTERACTION_SAMPLES);
    interactionLatencies.clear();
    for (const [interactionId, duration] of retainedEntries) {
        interactionLatencies.set(interactionId, duration);
    }
}
function isInpCandidate(entry) {
    if (!entry.interactionId || entry.interactionId <= 0) {
        return false;
    }
    if (entry.duration <= 0) {
        return false;
    }
    return INP_EVENT_WHITELIST.has(entry.name);
}
function scheduleFlush() {
    if (flushTimer !== null)
        return;
    flushTimer = window.setTimeout(() => {
        flushTimer = null;
        flushMetrics();
    }, 250);
}
function flushMetrics() {
    const snapshot = {
        cwv: {
            lcp: null,
            cls: null,
            inp: null,
            fcp: null,
            ttfb: null,
            ...vitals,
        },
        longTasks: [...longTasks],
        networkRequests: [],
        heapTimeline: [...heapTimeline],
        paintEvents: [],
        recordingStart: performance.timeOrigin,
    };
    const message = {
        type: "METRICS_UPDATE",
        tabId,
        timestamp: Date.now(),
        payload: snapshot,
    };
    try {
        if (typeof chrome === "undefined" ||
            !chrome.runtime ||
            !chrome.runtime.id ||
            typeof chrome.runtime.sendMessage !== "function") {
            return;
        }
        chrome.runtime.sendMessage(message).catch(() => {
            // Ignore teardown or sleeping worker errors.
        });
    }
    catch {
        // Ignore invalidated extension contexts.
    }
}
function trimArray(items, maxSize) {
    if (items.length <= maxSize)
        return;
    items.splice(0, items.length - maxSize);
}


/******/ })()
;
//# sourceMappingURL=content-script.js.map