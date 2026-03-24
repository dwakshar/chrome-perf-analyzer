import type {
  AnalysisResultPayload,
  CoreWebVitals,
  ExtensionMessage,
  MetricsSnapshot,
  PerformanceIssue,
  SessionHydratePayload,
  SessionInitPayload,
} from "../shared/types/messages.types.js";

const attachedTabs = new Map<number, boolean>();

interface SessionState {
  tabId: number;
  tabUrl: string;
  sessionId: string;
  recordingState: "idle" | "recording" | "paused";
  openedAt: number;
  metricsSnapshot: MetricsSnapshot | null;
  analysisSnapshot: AnalysisResultPayload | null;
}

interface ContentScriptMetricsPayload {
  cwv: CoreWebVitals;
  longTasks: MetricsSnapshot["longTasks"];
  networkRequests: MetricsSnapshot["networkRequests"];
  heapTimeline: MetricsSnapshot["heapTimeline"];
  paintEvents: MetricsSnapshot["paintEvents"];
  recordingStart: number;
}

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.error("[sw] Message handler error:", error);
        sendResponse({ error: String(error) });
      });

    return true;
  }
);

async function handleMessage(
  message: ExtensionMessage,
  sender?: chrome.runtime.MessageSender
): Promise<unknown> {
  const effectiveTabId =
    (message.tabId && message.tabId !== -1 ? message.tabId : undefined) ??
    sender?.tab?.id;

  if (!effectiveTabId) {
    console.warn("[sw] Dropping message without tabId:", message.type);
    return null;
  }

  message.tabId = effectiveTabId;

  switch (message.type) {
    case "DEVTOOLS_OPENED":
      return onDevToolsOpened(message as ExtensionMessage<SessionInitPayload>);
    case "DEVTOOLS_CLOSED":
      return onDevToolsClosed(effectiveTabId);
    case "PANEL_READY":
      return onPanelReady(effectiveTabId);
    case "CLEAR_SESSION":
      return onClearSession(effectiveTabId);
    case "RECORDING_START":
      return onRecordingStart(effectiveTabId);
    case "RECORDING_STOP":
      return onRecordingStop(effectiveTabId);
    case "METRICS_UPDATE":
      return onMetricsUpdate(
        effectiveTabId,
        message.payload as ContentScriptMetricsPayload
      );
    default:
      console.warn("[sw] Unhandled message type:", message.type);
      return null;
  }
}

async function onDevToolsOpened(
  message: ExtensionMessage<SessionInitPayload>
): Promise<{ ok: boolean }> {
  const { tabId, tabUrl, sessionId } = message.payload;
  const existing = await getSessionState(tabId);

  await setSessionState(tabId, {
    tabId,
    tabUrl,
    sessionId,
    recordingState: existing?.recordingState ?? "idle",
    openedAt: existing?.openedAt ?? Date.now(),
    metricsSnapshot: existing?.metricsSnapshot ?? null,
    analysisSnapshot: existing?.analysisSnapshot ?? null,
  });

  await attachDebugger(tabId);

  console.log(`[sw] Session initialized for tab ${tabId}`);
  return { ok: true };
}

async function onDevToolsClosed(tabId: number): Promise<void> {
  await detachDebugger(tabId);
  clearKeepAliveAlarm(tabId);
  await chrome.storage.session.remove(getSessionKey(tabId));
  console.log(`[sw] Cleaned up session for tab ${tabId}`);
}

async function onPanelReady(
  tabId: number
): Promise<SessionHydratePayload | null> {
  const session = await getSessionState(tabId);

  if (!session) {
    console.warn(`[sw] No session found for tab ${tabId} on PANEL_READY`);
    return null;
  }

  return {
    sessionId: session.sessionId,
    recordingState: session.recordingState,
    metricsSnapshot: session.metricsSnapshot,
    analysisSnapshot: session.analysisSnapshot,
  };
}

async function onClearSession(tabId: number): Promise<{ ok: boolean }> {
  const session = await getSessionState(tabId);
  if (!session) {
    return { ok: true };
  }

  clearKeepAliveAlarm(tabId);
  await updateSessionState(tabId, {
    recordingState: "idle",
    metricsSnapshot: null,
    analysisSnapshot: null,
  });

  return { ok: true };
}

async function onRecordingStart(tabId: number): Promise<void> {
  await updateSessionState(tabId, { recordingState: "recording" });
  ensureKeepAliveAlarm(tabId);

  await sendCDPCommand(tabId, "Performance.enable", {
    timeDomain: "timeTicks",
  });

  try {
    await sendCDPCommand(tabId, "HeapProfiler.startTrackingHeapObjects", {
      trackAllocations: true,
    });
  } catch (error) {
    console.warn(
      "[sw] HeapProfiler.startTrackingHeapObjects not available:",
      error
    );
  }
}

async function onRecordingStop(tabId: number): Promise<void> {
  await updateSessionState(tabId, { recordingState: "idle" });
  clearKeepAliveAlarm(tabId);

  try {
    await sendCDPCommand(tabId, "HeapProfiler.stopTrackingHeapObjects");
  } catch (error) {
    console.warn(
      "[sw] HeapProfiler.stopTrackingHeapObjects not available:",
      error
    );
  }
}

async function onMetricsUpdate(
  tabId: number,
  payload: ContentScriptMetricsPayload
): Promise<void> {
  const snapshot: MetricsSnapshot = {
    cwv: payload.cwv,
    longTasks: payload.longTasks,
    networkRequests: payload.networkRequests,
    heapTimeline: payload.heapTimeline,
    paintEvents: payload.paintEvents,
    recordingStart: payload.recordingStart,
  };

  const analysis: AnalysisResultPayload = {
    issues: deriveIssuesFromSnapshot(snapshot),
    score: computeOverallScore(snapshot),
    recommendations: deriveRecommendations(snapshot),
    analyzedAt: Date.now(),
  };

  await updateSessionState(tabId, {
    metricsSnapshot: snapshot,
    analysisSnapshot: analysis,
  });

  pushToPanel(tabId, {
    type: "METRICS_UPDATE",
    tabId,
    timestamp: Date.now(),
    payload: snapshot,
  });

  pushToPanel(tabId, {
    type: "ANALYSIS_RESULT",
    tabId,
    timestamp: Date.now(),
    payload: analysis,
  });
}

function deriveIssuesFromSnapshot(snapshot: MetricsSnapshot): PerformanceIssue[] {
  const { cwv, longTasks, heapTimeline } = snapshot;
  const issues: PerformanceIssue[] = [];
  const makeId = (suffix: string) => `cwv_${suffix}_${Date.now()}`;

  if (cwv.lcp !== null && cwv.lcp > 2500) {
    issues.push({
      id: makeId("lcp"),
      severity: cwv.lcp > 4000 ? "critical" : "warning",
      category: "rendering",
      title: `LCP is high (${Math.round(cwv.lcp)} ms)`,
      detail:
        "Largest Contentful Paint is slower than recommended. This often points to heavy hero images or render-blocking resources.",
      recommendation:
        "Optimize above-the-fold images and reduce render-blocking CSS and JavaScript.",
    });
  }

  if (cwv.inp !== null && cwv.inp > 200) {
    issues.push({
      id: makeId("inp"),
      severity: cwv.inp > 500 ? "critical" : "warning",
      category: "javascript",
      title: `INP is high (${Math.round(cwv.inp)} ms)`,
      detail:
        "Interaction to Next Paint is slower than recommended, which usually means event handlers or follow-up rendering work are blocking responsiveness.",
      recommendation:
        "Reduce synchronous work inside interaction handlers, defer non-critical updates, and break long JavaScript tasks into smaller chunks.",
    });
  }

  if (cwv.cls !== null && cwv.cls > 0.1) {
    issues.push({
      id: makeId("cls"),
      severity: cwv.cls > 0.25 ? "critical" : "warning",
      category: "rendering",
      title: `CLS is high (${cwv.cls.toFixed(3)})`,
      detail:
        "Cumulative Layout Shift is above the recommended threshold, so visible layout movement is occurring during load.",
      recommendation:
        "Reserve space for media and ads, avoid injecting content above existing content, and prefer transform-based animations.",
    });
  }

  if (cwv.fcp !== null && cwv.fcp > 1800) {
    issues.push({
      id: makeId("fcp"),
      severity: cwv.fcp > 3000 ? "warning" : "info",
      category: "rendering",
      title: `FCP is slow (${Math.round(cwv.fcp)} ms)`,
      detail:
        "First Contentful Paint is slower than recommended, indicating delayed initial rendering.",
      recommendation:
        "Reduce critical-path JavaScript and CSS and consider server-side rendering or static generation.",
    });
  }

  if (cwv.ttfb !== null && cwv.ttfb > 800) {
    issues.push({
      id: makeId("ttfb"),
      severity: cwv.ttfb > 1800 ? "warning" : "info",
      category: "network",
      title: `TTFB is high (${Math.round(cwv.ttfb)} ms)`,
      detail:
        "Time To First Byte is slower than recommended, which usually points to backend or CDN latency.",
      recommendation:
        "Profile server response times, improve caching, and reduce work on the critical request path.",
    });
  }

  const blockingLongTasks = longTasks.filter((task) => task.duration >= 50);
  const worstLongTask = blockingLongTasks.reduce(
    (max, task) => Math.max(max, task.duration),
    0
  );
  if (blockingLongTasks.length > 0) {
    issues.push({
      id: makeId("longtask"),
      severity:
        blockingLongTasks.length >= 5 || worstLongTask >= 200
          ? "critical"
          : "warning",
      category: "javascript",
      title: `${blockingLongTasks.length} long task${blockingLongTasks.length === 1 ? "" : "s"} detected`,
      detail: `Main-thread blocking work was observed during this session. The worst task took ${Math.round(
        worstLongTask
      )} ms, which can delay input and paint updates.`,
      recommendation:
        "Split heavy JavaScript into smaller async chunks, avoid expensive work during input handling, and move non-urgent computation off the critical path.",
    });
  }

  const heapIssue = analyzeHeapTrend(heapTimeline);
  if (heapIssue) {
    issues.push({
      id: makeId("heap"),
      severity: heapIssue.severity,
      category: "memory",
      title: heapIssue.title,
      detail: heapIssue.detail,
      recommendation:
        "Audit retained objects, clean up event listeners and timers, and verify that components release references after navigation or interaction cycles.",
    });
  }

  return issues;
}

function computeOverallScore(snapshot: MetricsSnapshot): number {
  const { cwv, longTasks, heapTimeline } = snapshot;
  let score = 100;

  if (cwv.lcp !== null) {
    if (cwv.lcp > 4000) score -= 25;
    else if (cwv.lcp > 2500) score -= 10;
  }

  if (cwv.cls !== null) {
    if (cwv.cls > 0.25) score -= 20;
    else if (cwv.cls > 0.1) score -= 8;
  }

  if (cwv.inp !== null) {
    if (cwv.inp > 500) score -= 20;
    else if (cwv.inp > 200) score -= 8;
  }

  if (cwv.fcp !== null) {
    if (cwv.fcp > 3000) score -= 10;
    else if (cwv.fcp > 1800) score -= 5;
  }

  if (cwv.ttfb !== null) {
    if (cwv.ttfb > 1800) score -= 10;
    else if (cwv.ttfb > 800) score -= 5;
  }

  const blockingLongTasks = longTasks.filter((task) => task.duration >= 50);
  if (blockingLongTasks.length >= 5) score -= 18;
  else if (blockingLongTasks.length >= 1) score -= 8;

  const heapIssue = analyzeHeapTrend(heapTimeline);
  if (heapIssue?.severity === "critical") score -= 15;
  else if (heapIssue?.severity === "warning") score -= 6;

  return Math.max(0, Math.min(100, score));
}

function deriveRecommendations(snapshot: MetricsSnapshot): string[] {
  const recommendations = new Set<string>();
  const { cwv, longTasks, heapTimeline } = snapshot;

  if (cwv.lcp !== null && cwv.lcp > 2500) {
    recommendations.add(
      "Prioritize above-the-fold rendering by compressing hero assets and reducing render-blocking CSS and JavaScript."
    );
  }

  if (cwv.inp !== null && cwv.inp > 200) {
    recommendations.add(
      "Trim interaction handler work and defer non-urgent updates to keep input responsiveness smooth."
    );
  }

  if (cwv.cls !== null && cwv.cls > 0.1) {
    recommendations.add(
      "Reserve layout space for dynamic content and media to avoid visible shifts."
    );
  }

  if (cwv.ttfb !== null && cwv.ttfb > 800) {
    recommendations.add(
      "Reduce backend latency and improve caching on the initial navigation request."
    );
  }

  if (longTasks.some((task) => task.duration >= 50)) {
    recommendations.add(
      "Break long JavaScript work into smaller chunks and move non-critical work away from the main thread."
    );
  }

  if (analyzeHeapTrend(heapTimeline)) {
    recommendations.add(
      "Review memory retention patterns, especially event listeners, timers, and long-lived references."
    );
  }

  return Array.from(recommendations);
}

function analyzeHeapTrend(
  heapTimeline: MetricsSnapshot["heapTimeline"]
):
  | {
      severity: "warning" | "critical";
      title: string;
      detail: string;
    }
  | null {
  if (heapTimeline.length < 3) {
    return null;
  }

  const first = heapTimeline[0]!;
  const last = heapTimeline[heapTimeline.length - 1]!;
  const deltaBytes = last.usedJSHeapSize - first.usedJSHeapSize;
  const deltaMb = deltaBytes / 1_048_576;
  const growthRatio = first.usedJSHeapSize > 0 ? deltaBytes / first.usedJSHeapSize : 0;

  if (deltaMb >= 30 || growthRatio >= 0.6) {
    return {
      severity: "critical",
      title: `Heap usage grew sharply (+${deltaMb.toFixed(1)} MB)`,
      detail:
        "Memory usage increased substantially during the session, which can indicate retained objects or cleanup not happening as expected.",
    };
  }

  if (deltaMb >= 12 || growthRatio >= 0.25) {
    return {
      severity: "warning",
      title: `Heap usage is trending upward (+${deltaMb.toFixed(1)} MB)`,
      detail:
        "Memory growth was observed during the session. This may be normal for some pages, but it can also indicate growing retained state.",
    };
  }

  return null;
}

async function attachDebugger(tabId: number): Promise<void> {
  if (attachedTabs.get(tabId)) return;

  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.set(tabId, true);

  await Promise.all([
    sendCDPCommand(tabId, "Network.enable", { maxPostDataSize: 65_536 }),
    sendCDPCommand(tabId, "Runtime.enable"),
    sendCDPCommand(tabId, "Page.enable"),
  ]);
}

async function detachDebugger(tabId: number): Promise<void> {
  if (!attachedTabs.get(tabId)) return;

  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Tab may already be gone.
  } finally {
    attachedTabs.delete(tabId);
  }
}

async function sendCDPCommand<T = unknown>(
  tabId: number,
  method: string,
  params?: object
): Promise<T> {
  return chrome.debugger.sendCommand(
    { tabId },
    method,
    params ?? {}
  ) as Promise<T>;
}

chrome.debugger.onEvent.addListener(
  (source: chrome.debugger.Debuggee, method: string, params?: unknown) => {
    if (!source.tabId) return;

    pushToPanel(source.tabId, {
      type: "CDP_EVENT",
      tabId: source.tabId,
      timestamp: Date.now(),
      payload: { method, params },
    });
  }
);

function pushToPanel(tabId: number, message: ExtensionMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // The panel may not be open.
  });
}

function getSessionKey(tabId: number): string {
  return `session:${tabId}`;
}

async function getSessionState(tabId: number): Promise<SessionState | null> {
  const key = getSessionKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return (stored[key] as SessionState | undefined) ?? null;
}

async function setSessionState(
  tabId: number,
  value: SessionState
): Promise<void> {
  await chrome.storage.session.set({ [getSessionKey(tabId)]: value });
}

async function updateSessionState(
  tabId: number,
  patch: Partial<SessionState>
): Promise<void> {
  const existing = await getSessionState(tabId);
  if (!existing) return;

  await setSessionState(tabId, { ...existing, ...patch });
}

function getKeepAliveAlarmName(tabId: number): string {
  return `perf-keepalive-${tabId}`;
}

function ensureKeepAliveAlarm(tabId: number): void {
  if (typeof chrome.alarms === "undefined") return;

  chrome.alarms.create(getKeepAliveAlarmName(tabId), {
    delayInMinutes: 0.5,
    periodInMinutes: 0.5,
  });
}

function clearKeepAliveAlarm(tabId: number): void {
  if (typeof chrome.alarms === "undefined") return;

  chrome.alarms.clear(getKeepAliveAlarmName(tabId)).catch(() => {
    // Ignore missing alarms.
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!attachedTabs.has(tabId)) return;

  detachDebugger(tabId).catch(console.error);
  clearKeepAliveAlarm(tabId);
  chrome.storage.session.remove(getSessionKey(tabId)).catch(console.error);
});

if (typeof chrome.alarms !== "undefined") {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name.startsWith("perf-keepalive-")) {
      console.debug("[sw] Keepalive ping");
    }
  });
}
