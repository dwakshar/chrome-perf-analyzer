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
/**
 * content-script.ts
 *
 * Injected into every page at document_start.
 * Collects Core Web Vitals via PerformanceObserver (where supported) and
 * forwards them to the extension service worker.
 */
// Content scripts don't know their tabId; the SW resolves it via sender.tab.id.
const tabId = -1;
// ── PerformanceObserver: LCP, CLS, FCP ────────────────────────────────────────
const vitals = {};
const hasPO = typeof PerformanceObserver !== "undefined";
const supportedEntryTypes = hasPO && Array.isArray(PerformanceObserver.supportedEntryTypes)
    ? PerformanceObserver.supportedEntryTypes
    : [];
function canObserve(type) {
    if (!hasPO)
        return false;
    // If supportedEntryTypes is empty, fall back to trying — older implementations.
    if (supportedEntryTypes.length === 0)
        return true;
    return supportedEntryTypes.includes(type);
}
function observe(type, callback) {
    if (!canObserve(type))
        return;
    try {
        const po = new PerformanceObserver(callback);
        po.observe({ type, buffered: true });
    }
    catch {
        // Not all browsers / contexts support all entry types.
    }
}
// LCP
observe("largest-contentful-paint", (list) => {
    const entries = list.getEntries();
    const last = entries[entries.length - 1];
    if (last)
        vitals.lcp = last.startTime;
    flushVitals();
});
// CLS
observe("layout-shift", (list) => {
    let cls = vitals.cls ?? 0;
    for (const entry of list.getEntries()) {
        const ls = entry;
        if (!ls.hadRecentInput)
            cls += ls.value;
    }
    vitals.cls = cls;
    flushVitals();
});
// FCP uses entry type "paint" with name "first-contentful-paint".
if (canObserve("paint")) {
    try {
        const po = new PerformanceObserver((list) => {
            const entry = list.getEntriesByName("first-contentful-paint")[0];
            if (entry)
                vitals.fcp = entry.startTime;
            flushVitals();
        });
        po.observe({ type: "paint", buffered: true });
    }
    catch {
        // Ignore if paint entries cannot be observed.
    }
}
// Navigation timing for TTFB
window.addEventListener("load", () => {
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav)
        vitals.ttfb = nav.responseStart - nav.requestStart;
    flushVitals();
});
function flushVitals() {
    const message = {
        type: "METRICS_UPDATE",
        tabId,
        timestamp: Date.now(),
        payload: {
            cwv: {
                lcp: null,
                cls: null,
                inp: null,
                fcp: null,
                ttfb: null,
                ...vitals,
            },
        },
    };
    try {
        // In some navigation / teardown paths the extension context can already be
        // invalidated; guard access to chrome.runtime to avoid noisy errors.
        if (typeof chrome === "undefined" ||
            !chrome.runtime ||
            !chrome.runtime.id ||
            typeof chrome.runtime.sendMessage !== "function") {
            return;
        }
        chrome.runtime
            .sendMessage(message)
            .catch(() => {
            // Service worker may be sleeping or context may be gone; ignore.
        });
    }
    catch {
        // If the extension context is invalidated, accessing chrome.* can throw;
        // swallow the error since metrics are best-effort only.
    }
}


/******/ })()
;
//# sourceMappingURL=content-script.js.map