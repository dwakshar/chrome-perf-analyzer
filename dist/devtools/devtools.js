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
/*!**********************************!*\
  !*** ./src/devtools/devtools.ts ***!
  \**********************************/
__webpack_require__.r(__webpack_exports__);
/**
 * devtools.ts
 *
 * Entry point loaded by Chrome when DevTools opens for any inspected tab.
 * Runs in the "devtools page" context — has access to chrome.devtools.* APIs
 * but NOT to DOM of the inspected page or chrome.debugger directly.
 *
 * Responsibilities:
 *   1. Register the "⚡ Perf" panel via chrome.devtools.panels.create()
 *   2. Notify the service worker that DevTools is open for this tab
 *   3. Wire panel show/hide lifecycle events
 *   4. Establish the devtools ↔ service worker message channel
 */
// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const PANEL_TITLE = "⚡ Perf";
// Resolved relative to dist/devtools/devtools.html
const PANEL_ICON = "../icons/icon32.png";
const PANEL_PAGE = "../panel/panel.html";
const INSPECTED_TAB_ID = chrome.devtools.inspectedWindow.tabId;
// ─────────────────────────────────────────────────────────────────────────────
// DevTools Initialization
// ─────────────────────────────────────────────────────────────────────────────
async function init() {
    console.log(`[devtools] Initializing for tab ${INSPECTED_TAB_ID}`);
    // 1. Notify service worker that DevTools opened for this tab.
    //    The SW will attach the Chrome Debugger and start collector registration.
    await notifyServiceWorker('DEVTOOLS_OPENED', {
        tabId: INSPECTED_TAB_ID,
        tabUrl: await getInspectedTabUrl(),
        sessionId: generateSessionId(),
    });
    // 2. Register the panel — this creates the visible tab in DevTools UI.
    const panel = await registerPanel();
    // 3. Wire panel lifecycle.
    wireLifecycle(panel);
}
// ─────────────────────────────────────────────────────────────────────────────
// Panel Registration
// ─────────────────────────────────────────────────────────────────────────────
function registerPanel() {
    return new Promise((resolve, reject) => {
        chrome.devtools.panels.create(PANEL_TITLE, PANEL_ICON, PANEL_PAGE, (panel) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            console.log('[devtools] Panel registered successfully');
            resolve(panel);
        });
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Panel Lifecycle
// ─────────────────────────────────────────────────────────────────────────────
function wireLifecycle(panel) {
    // onShown fires each time the user clicks into the Perf panel.
    // `window` here is the panel's window object — use it to communicate
    // with panel.ts via direct property assignment or postMessage.
    panel.onShown.addListener((panelWindow) => {
        console.log("[devtools] Panel shown");
        try {
            // Expose the inspected tab ID to the panel page immediately.
            panelWindow.__PERF_TAB_ID__ = INSPECTED_TAB_ID;
        }
        catch (err) {
            // If the panel failed to load and Chrome shows a chrome-error page,
            // accessing panelWindow can throw a cross-origin error. Log and bail.
            console.warn("[devtools] Failed to inject tab id into panel window:", err);
            return;
        }
        // Ask the SW to push current session state to the panel.
        notifyServiceWorker("PANEL_READY", { tabId: INSPECTED_TAB_ID });
    });
    panel.onHidden.addListener(() => {
        console.log('[devtools] Panel hidden');
        // Panel is hidden but NOT destroyed — state persists in service worker.
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Service Worker Communication
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Send a typed message to the extension service worker.
 * Returns the SW's response (if any).
 */
async function notifyServiceWorker(type, payload) {
    const message = {
        type,
        tabId: INSPECTED_TAB_ID,
        timestamp: Date.now(),
        payload,
    };
    try {
        return await chrome.runtime.sendMessage(message);
    }
    catch (err) {
        // Service worker may be starting up — log but don't crash devtools page.
        console.warn(`[devtools] SW message failed (${type}):`, err);
        return null;
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function getInspectedTabUrl() {
    // The tab URL is currently only used for logging in the service worker.
    // To avoid noisy "Extension context invalidated" errors when DevTools or the
    // inspected page is tearing down, we simply skip the inspectedWindow.eval
    // call and return an empty string.
    return Promise.resolve("");
}
function generateSessionId() {
    return `session_${INSPECTED_TAB_ID}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
// ─────────────────────────────────────────────────────────────────────────────
// Cleanup on DevTools close
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener("beforeunload", () => {
    // Fire-and-forget — the SW will detach the debugger and clean up collectors.
    // When DevTools is tearing down the extension context can already be
    // invalidated, so guard access to chrome.runtime to avoid noisy errors.
    try {
        if (typeof chrome === "undefined" ||
            !chrome.runtime ||
            !chrome.runtime.id ||
            typeof chrome.runtime.sendMessage !== "function") {
            return;
        }
    }
    catch {
        return;
    }
    chrome.runtime
        .sendMessage({
        type: "DEVTOOLS_CLOSED",
        tabId: INSPECTED_TAB_ID,
        timestamp: Date.now(),
        payload: null,
    })
        .catch(() => {
        /* SW may already be inactive */
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
init().catch((err) => {
    console.error('[devtools] Initialization failed:', err);
});


/******/ })()
;
//# sourceMappingURL=devtools.js.map