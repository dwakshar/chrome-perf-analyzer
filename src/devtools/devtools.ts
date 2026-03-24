import type {
  ExtensionMessage,
  SessionInitPayload,
} from "../shared/types/messages.types.js";

const PANEL_TITLE = "Perf";
const PANEL_ICON = "../icons/icon32.png";
const PANEL_PAGE = "../panel/panel.html";
const inspectedTabId = chrome.devtools.inspectedWindow.tabId;

async function init(): Promise<void> {
  await notifyServiceWorker("DEVTOOLS_OPENED", {
    tabId: inspectedTabId,
    tabUrl: "",
    sessionId: generateSessionId(),
  } satisfies SessionInitPayload);

  const panel = await registerPanel();
  wireLifecycle(panel);
}

function registerPanel(): Promise<chrome.devtools.panels.ExtensionPanel> {
  return new Promise((resolve, reject) => {
    chrome.devtools.panels.create(
      PANEL_TITLE,
      PANEL_ICON,
      PANEL_PAGE,
      (panel) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(panel);
      }
    );
  });
}

function wireLifecycle(panel: chrome.devtools.panels.ExtensionPanel): void {
  panel.onShown.addListener((panelWindow: Window) => {
    try {
      (panelWindow as Window & { __PERF_TAB_ID__?: number }).__PERF_TAB_ID__ =
        inspectedTabId;
    } catch (error) {
      console.warn("[devtools] Failed to inject tab id into panel window:", error);
      return;
    }

    void notifyServiceWorker("PANEL_READY", { tabId: inspectedTabId });
  });
}

async function notifyServiceWorker<T>(
  type: ExtensionMessage["type"],
  payload: T
): Promise<unknown> {
  const message: ExtensionMessage<T> = {
    type,
    tabId: inspectedTabId,
    timestamp: Date.now(),
    payload,
  };

  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    console.warn(`[devtools] SW message failed (${type}):`, error);
    return null;
  }
}

function generateSessionId(): string {
  return `session_${inspectedTabId}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

window.addEventListener("beforeunload", () => {
  try {
    if (
      typeof chrome === "undefined" ||
      !chrome.runtime ||
      !chrome.runtime.id ||
      typeof chrome.runtime.sendMessage !== "function"
    ) {
      return;
    }
  } catch {
    return;
  }

  chrome.runtime
    .sendMessage({
      type: "DEVTOOLS_CLOSED",
      tabId: inspectedTabId,
      timestamp: Date.now(),
      payload: null,
    })
    .catch(() => {
      // Ignore teardown errors.
    });
});

init().catch((error) => {
  console.error("[devtools] Initialization failed:", error);
});
