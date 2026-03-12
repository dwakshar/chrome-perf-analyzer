/**
 * content-script.ts
 *
 * Injected into every page at document_start.
 * Collects Core Web Vitals via PerformanceObserver (where supported) and
 * forwards them to the extension service worker.
 */

import type {
  CoreWebVitals,
  ExtensionMessage,
} from "../shared/types/messages.types.js";

// Content scripts don't know their tabId; the SW resolves it via sender.tab.id.
const tabId = -1;

// ── PerformanceObserver: LCP, CLS, FCP ────────────────────────────────────────

const vitals: Partial<CoreWebVitals> = {};

const hasPO = typeof PerformanceObserver !== "undefined";
const supportedEntryTypes: readonly string[] =
  hasPO && Array.isArray(PerformanceObserver.supportedEntryTypes)
    ? PerformanceObserver.supportedEntryTypes
    : [];

function canObserve(type: string): boolean {
  if (!hasPO) return false;
  // If supportedEntryTypes is empty, fall back to trying — older implementations.
  if (supportedEntryTypes.length === 0) return true;
  return supportedEntryTypes.includes(type);
}

function observe(type: string, callback: PerformanceObserverCallback): void {
  if (!canObserve(type)) return;

  try {
    const po = new PerformanceObserver(callback);
    po.observe({ type, buffered: true });
  } catch {
    // Not all browsers / contexts support all entry types.
  }
}

// LCP
observe("largest-contentful-paint", (list) => {
  const entries = list.getEntries();
  const last = entries[entries.length - 1] as
    | (PerformanceEntry & { startTime: number })
    | undefined;
  if (last) vitals.lcp = last.startTime;
  flushVitals();
});

// CLS
observe("layout-shift", (list) => {
  let cls = vitals.cls ?? 0;
  for (const entry of list.getEntries()) {
    const ls = entry as PerformanceEntry & {
      hadRecentInput: boolean;
      value: number;
    };
    if (!ls.hadRecentInput) cls += ls.value;
  }
  vitals.cls = cls;
  flushVitals();
});

// FCP uses entry type "paint" with name "first-contentful-paint".
if (canObserve("paint")) {
  try {
    const po = new PerformanceObserver((list) => {
      const entry = list.getEntriesByName(
        "first-contentful-paint"
      )[0] as PerformanceEntry | undefined;
      if (entry) vitals.fcp = entry.startTime;
      flushVitals();
    });

    po.observe({ type: "paint", buffered: true });
  } catch {
    // Ignore if paint entries cannot be observed.
  }
}

// Navigation timing for TTFB
window.addEventListener("load", () => {
  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (nav) vitals.ttfb = nav.responseStart - nav.requestStart;
  flushVitals();
});

function flushVitals(): void {
  const message: ExtensionMessage = {
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
    if (
      typeof chrome === "undefined" ||
      !chrome.runtime ||
      !chrome.runtime.id ||
      typeof chrome.runtime.sendMessage !== "function"
    ) {
      return;
    }

    chrome.runtime
      .sendMessage(message)
      .catch(() => {
        // Service worker may be sleeping or context may be gone; ignore.
      });
  } catch {
    // If the extension context is invalidated, accessing chrome.* can throw;
    // swallow the error since metrics are best-effort only.
  }
}