import type {
  CoreWebVitals,
  ExtensionMessage,
  HeapSummary,
  LongTask,
  MetricsSnapshot,
} from "../shared/types/messages.types.js";

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

type PerformanceWithMemory = Performance & {
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
  };
};

type EventTimingEntry = PerformanceEntry & {
  duration: number;
  interactionId?: number;
  name: string;
};

type PerformanceObserverInitWithDurationThreshold = PerformanceObserverInit & {
  durationThreshold?: number;
};

type LongTaskEntry = PerformanceEntry & {
  duration: number;
  attribution?: Array<{
    name?: string;
    scriptUrl?: string;
    functionName?: string;
  }>;
};

const vitals: Partial<CoreWebVitals> = {};
const longTasks: LongTask[] = [];
const heapTimeline: HeapSummary[] = [];
const interactionLatencies = new Map<number, number>();

let flushTimer: number | null = null;
let heapSampleTimer: number | null = null;

const hasPerformanceObserver = typeof PerformanceObserver !== "undefined";
const supportedEntryTypes: readonly string[] =
  hasPerformanceObserver &&
  Array.isArray(PerformanceObserver.supportedEntryTypes)
    ? PerformanceObserver.supportedEntryTypes
    : [];

function canObserve(type: string): boolean {
  if (!hasPerformanceObserver) return false;
  if (supportedEntryTypes.length === 0) return true;
  return supportedEntryTypes.includes(type);
}

function observe(type: string, callback: PerformanceObserverCallback): void {
  if (!canObserve(type)) return;

  try {
    const observer = new PerformanceObserver(callback);
    if (type === "event") {
      observer.observe({
        type,
        buffered: true,
        durationThreshold: EVENT_OBSERVER_DURATION_THRESHOLD_MS,
      } as PerformanceObserverInitWithDurationThreshold);
      return;
    }

    observer.observe({ type, buffered: true });
  } catch {
    // Unsupported in this context.
  }
}

observe("largest-contentful-paint", (list) => {
  const entries = list.getEntries();
  const lastEntry = entries.at(-1) as
    | (PerformanceEntry & { startTime: number })
    | undefined;

  if (!lastEntry) return;
  vitals.lcp = lastEntry.startTime;
  scheduleFlush();
});

observe("layout-shift", (list) => {
  let cls = vitals.cls ?? 0;

  for (const entry of list.getEntries()) {
    const layoutShift = entry as PerformanceEntry & {
      hadRecentInput: boolean;
      value: number;
    };

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
      const entry = list.getEntriesByName(
        "first-contentful-paint"
      )[0] as PerformanceEntry | undefined;

      if (!entry) return;
      vitals.fcp = entry.startTime;
      scheduleFlush();
    });

    observer.observe({ type: "paint", buffered: true });
  } catch {
    // Unsupported in this context.
  }
}

observe("event", (list) => {
  for (const entry of list.getEntries()) {
    const eventEntry = entry as EventTimingEntry;
    if (!isInpCandidate(eventEntry)) continue;

    const currentLatency =
      interactionLatencies.get(eventEntry.interactionId) ?? 0;
    interactionLatencies.set(
      eventEntry.interactionId,
      Math.max(currentLatency, eventEntry.duration)
    );
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
    const longTaskEntry = entry as LongTaskEntry;
    const attribution = longTaskEntry.attribution?.[0];
    const longTask: LongTask = {
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

window.addEventListener(
  "load",
  () => {
    const navigationEntry = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;

    if (navigationEntry) {
      vitals.ttfb = navigationEntry.responseStart - navigationEntry.requestStart;
    }

    sampleHeap();
    startHeapSampling();
    scheduleFlush();
  },
  { once: true }
);

window.addEventListener(
  "pagehide",
  () => {
    stopHeapSampling();
    finalizeInp();
    flushMetrics();
  },
  { once: true }
);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  finalizeInp();
  flushMetrics();
});

function startHeapSampling(): void {
  if (heapSampleTimer !== null) return;

  heapSampleTimer = window.setInterval(() => {
    sampleHeap();
    scheduleFlush();
  }, HEAP_SAMPLE_INTERVAL_MS);
}

function stopHeapSampling(): void {
  if (heapSampleTimer === null) return;

  window.clearInterval(heapSampleTimer);
  heapSampleTimer = null;
}

function sampleHeap(): void {
  const memory = (performance as PerformanceWithMemory).memory;
  if (!memory) return;

  heapTimeline.push({
    usedJSHeapSize: memory.usedJSHeapSize,
    totalJSHeapSize: memory.totalJSHeapSize,
    timestamp: Date.now(),
  });

  trimArray(heapTimeline, MAX_HEAP_SAMPLES);
}

function computeObservedInp(): number | null {
  const sortedLatencies = Array.from(interactionLatencies.values()).sort(
    (left, right) => right - left
  );

  if (sortedLatencies.length === 0) {
    return null;
  }

  // Mirror the standard "ignore one worst interaction per 50" rule.
  const ignoredCount = Math.min(
    Math.floor(sortedLatencies.length / 50),
    Math.max(0, sortedLatencies.length - 1)
  );

  return sortedLatencies[ignoredCount] ?? sortedLatencies[0] ?? null;
}

function finalizeInp(): void {
  const observedInp = computeObservedInp();
  if (observedInp !== null) {
    vitals.inp = observedInp;
  }
}

function pruneInteractionLatencies(): void {
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

function isInpCandidate(entry: EventTimingEntry): entry is EventTimingEntry & {
  interactionId: number;
} {
  if (!entry.interactionId || entry.interactionId <= 0) {
    return false;
  }

  if (entry.duration <= 0) {
    return false;
  }

  return INP_EVENT_WHITELIST.has(entry.name);
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;

  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    flushMetrics();
  }, 250);
}

function flushMetrics(): void {
  const snapshot: MetricsSnapshot = {
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

  const message: ExtensionMessage<MetricsSnapshot> = {
    type: "METRICS_UPDATE",
    tabId,
    timestamp: Date.now(),
    payload: snapshot,
  };

  try {
    if (
      typeof chrome === "undefined" ||
      !chrome.runtime ||
      !chrome.runtime.id ||
      typeof chrome.runtime.sendMessage !== "function"
    ) {
      return;
    }

    chrome.runtime.sendMessage(message).catch(() => {
      // Ignore teardown or sleeping worker errors.
    });
  } catch {
    // Ignore invalidated extension contexts.
  }
}

function trimArray<T>(items: T[], maxSize: number): void {
  if (items.length <= maxSize) return;
  items.splice(0, items.length - maxSize);
}
