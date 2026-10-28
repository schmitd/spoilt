import { browser } from "wxt/browser";
import { HOST_PORT, NATIVE_RETRY_KEY, validRequestId, validateNativeInput } from "../../core/native-ai-protocol";
import type { Settings } from "../../core/types";
import { loadSettings, watchSettings } from "../../platform/storage";
import { NativeAiEngine } from "../../services/native-ai-engine";
import "./style.css";

const engine = new NativeAiEngine();
const main = document.querySelector("main")!;
const connection = document.querySelector("#connection")!;
const minimizeAfterSetup = document.querySelector<HTMLInputElement>("#minimize-after-setup")!;
const windowState = document.querySelector("#window-state")!;
const modelKinds = ["text", "image"] as const;
const jobs = new Map<string, AbortController>();
let port: Browser.runtime.Port | null = null;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let closed = false;
let preparing = false;
let reconnectDelay = 1000;
const eligible = new Map<string, boolean>();
const allowed = new Map<string, boolean>();
const observedAvailability = new Map<string, string>();
let refreshVersion = 0;
let ownWindowId: number | undefined;
let ownTabId: number | undefined;
let watchingTabAttachments = false;
let windowVersion = 0;
let announced = false;

function retryExistingPages() {
  // Contains no URL, snippet, prompt, or model result. Ordinary classifications never write it.
  void browser.storage.local.set({ [NATIVE_RETRY_KEY]: crypto.randomUUID() }).catch(() => undefined);
}

function connect() {
  if (closed) return;
  try {
    const next = browser.runtime.connect({ name: HOST_PORT });
    port = next;
    next.onMessage.addListener((message: unknown) => {
      if (closed || port !== next || !message || typeof message !== "object") return;
      const value = message as Record<string, unknown>;
      if (value.type === "connected") {
        reconnectDelay = 1000;
        (main as HTMLElement).dataset.nativeHost = "connected";
        connection.textContent = "Connected. Keep this window open while browsing. Reopen Prepare in Spoilt to check its status.";
        if (!announced) { announced = true; retryExistingPages(); }
        return;
      }
      if (!validRequestId(value.requestId)) return;
      const requestId = value.requestId;
      if (value.type === "cancel") { jobs.get(requestId)?.abort(); return; }
      if (value.type !== "classify" || !validateNativeInput(value.input)) return;
      if (jobs.size >= 8 || jobs.has(requestId) || preparing) {
        reply(next, requestId, { ok: false, reason: "busy" });
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      jobs.set(requestId, controller);
      void engine.classify(value.input, controller.signal).then((response) => {
        reply(next, requestId, response);
      }).catch(() => {
        reply(next, requestId, { ok: false, reason: "failed" });
      }).finally(() => { clearTimeout(timer); jobs.delete(requestId); });
    });
    next.onDisconnect.addListener(() => {
      if (port !== next) return;
      port = null;
      for (const job of jobs.values()) job.abort();
      jobs.clear();
      (main as HTMLElement).dataset.nativeHost = "connecting";
      connection.textContent = "Reconnecting to Spoilt. Keyword protection remains active.";
      if (!closed) {
        reconnect = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(30_000, reconnectDelay * 2);
      }
    });
  } catch {
    connection.textContent = "Reload this tab to reconnect to Spoilt.";
  }
}

function reply(target: Browser.runtime.Port, requestId: string, response: unknown) {
  if (port !== target) return;
  try { target.postMessage({ type: "result", requestId, response }); }
  catch { /* The background may have closed its port before onDisconnect is delivered. */ }
}

function availabilityMessage(availability: string) {
  return availability === "available" ? "Model installed. A successful local check is required to verify analysis."
      : availability === "downloadable" ? "A download is required. Choose Prepare to consent to Chrome's model download and a local readiness check."
      : availability === "downloading" ? "Chrome is downloading this model. You can retry preparation when it finishes."
      : availability === "disabled" ? "Enable on-device analysis in Manage boundaries to use this model."
      : "This model is unavailable in this Chrome profile. Keyword and description matching remain active.";
}

function updateButtons() {
  for (const kind of modelKinds) {
    (document.querySelector(`#prepare-${kind}`) as HTMLButtonElement).disabled = preparing || !eligible.get(kind);
  }
}

async function refreshAvailability(nextSettings?: Settings) {
  const version = ++refreshVersion;
  const settings = nextSettings ?? await loadSettings();
  if (closed || version !== refreshVersion) return;
  // Apply privacy changes before any native probe can stall or resolve out of order.
  for (const kind of modelKinds) {
    const enabled = settings.useLocalAI && (kind === "text" || settings.useVision);
    allowed.set(kind, enabled);
    if (!enabled) {
      eligible.set(kind, false);
      observedAvailability.set(kind, "disabled");
      document.querySelector(`#${kind}-state`)!.textContent = availabilityMessage("disabled");
    }
  }
  updateButtons();
  const availability = await Promise.all(modelKinds.map(async (kind) => ({
    kind, value: allowed.get(kind) ? await engine.availability(kind) : "disabled",
  })));
  if (closed || version !== refreshVersion) return;
  for (const { kind, value } of availability) {
    const previous = observedAvailability.get(kind);
    observedAvailability.set(kind, value);
    eligible.set(kind, Boolean(allowed.get(kind)) && value !== "unavailable");
    // A focus check must not replace download progress or an unchanged readiness result.
    if (!preparing && value !== previous) document.querySelector(`#${kind}-state`)!.textContent = availabilityMessage(value);
  }
  updateButtons();
}

function refreshOnFocus() { void refreshAvailability(); void identifyWindow(); }
function refreshWhenVisible() { if (document.visibilityState === "visible") refreshOnFocus(); }

function refreshOnOwnTabAttached(tabId: number) {
  if (!closed && tabId === ownTabId) void identifyWindow();
}

async function trackWindowAttachment() {
  try {
    browser.tabs.onAttached.addListener(refreshOnOwnTabAttached);
    watchingTabAttachments = true;
    const tab = await browser.tabs.getCurrent();
    if (closed) return;
    ownTabId = typeof tab?.id === "number" && tab.id >= 0 ? tab.id : undefined;
  } catch { /* Window controls remain usable if tab identity is unavailable. */ }
  // Moving a live tab need not fire DOM focus/visibility. Reading after the tab
  // lookup also catches any attachment that happened before its identity resolved.
  if (!closed) void identifyWindow();
}

async function identifyWindow() {
  const version = ++windowVersion;
  try {
    const current = await browser.windows.getCurrent();
    if (closed || version !== windowVersion) return;
    if (current.type === "popup" && typeof current.id === "number" && current.id >= 0) {
      ownWindowId = current.id;
      minimizeAfterSetup.disabled = false;
      windowState.textContent = "Minimizing keeps this window open. Chrome may pause it under memory pressure; reopen Prepare in Spoilt to check its status.";
      return;
    }
  } catch { /* A normal analysis tab remains usable without window controls. */ }
  if (closed || version !== windowVersion) return;
  ownWindowId = undefined;
  minimizeAfterSetup.disabled = true;
  windowState.textContent = "This analysis tab stays open after setup. Automatic minimization is available only in a dedicated Spoilt window.";
}

async function minimizeAfterSuccess(kind: "text" | "image") {
  if (closed || !allowed.get(kind) || !minimizeAfterSetup.checked || ownWindowId === undefined) return;
  try {
    // Recheck the containing window: a legacy tab or a tab moved into a normal window
    // must never minimize the user's browser window.
    const current = await browser.windows.getCurrent();
    if (closed || !allowed.get(kind) || !minimizeAfterSetup.checked) return;
    if (current.id !== ownWindowId || current.type !== "popup") {
      minimizeAfterSetup.disabled = true;
      ownWindowId = undefined;
      windowState.textContent = "Setup succeeded. This browser window will stay open; use its window controls if you want to minimize it.";
      return;
    }
    await browser.windows.update(ownWindowId, { state: "minimized" });
    if (!closed) windowState.textContent = "Setup succeeded. Restore this window from Chrome or choose Prepare in Spoilt to reopen it.";
  } catch {
    if (!closed) windowState.textContent = "Setup succeeded. Chrome could not minimize this window automatically; use its window controls if needed.";
  }
}

for (const kind of modelKinds) {
  document.querySelector(`#prepare-${kind}`)!.addEventListener("click", () => {
    if (preparing || !eligible.get(kind)) return;
    if (jobs.size) {
      document.querySelector(`#${kind}-state`)!.textContent = "A page is being analyzed. Retry preparation after that check finishes.";
      return;
    }
    ++refreshVersion;
    preparing = true;
    updateButtons();
    const state = document.querySelector(`#${kind}-state`)!;
    state.textContent = "Preparing and verifying locally…";
    // No awaited work before prepare: create retains the button's user activation.
    void engine.prepare(kind, (progress) => { if (!closed && allowed.get(kind)) state.textContent = `Downloading: ${Math.round(progress * 100)}%.`; }).then(async (ready) => {
      if (closed || !allowed.get(kind)) return;
      if (ready) retryExistingPages();
      if (ready) observedAvailability.set(kind, "available");
      state.textContent = ready ? "Ready: a local readiness prompt succeeded. Keep this window open while browsing."
        : "Preparation could not be verified. Keyword protection remains active. Chrome may not support this model on this device.";
      if (ready) await minimizeAfterSuccess(kind);
    }).catch(() => {
      if (!closed && allowed.get(kind)) state.textContent = "Preparation could not finish. Keyword protection remains active. Reload this window to retry.";
    }).finally(() => {
      preparing = false;
      if (!closed) { updateButtons(); void refreshAvailability(); }
    });
  });
}

const stopWatchingSettings = watchSettings((settings) => { void refreshAvailability(settings); });
window.addEventListener("focus", refreshOnFocus);
document.addEventListener("visibilitychange", refreshWhenVisible);
window.addEventListener("pagehide", () => {
  closed = true;
  ++refreshVersion;
  ++windowVersion;
  stopWatchingSettings();
  if (watchingTabAttachments) browser.tabs.onAttached.removeListener(refreshOnOwnTabAttached);
  window.removeEventListener("focus", refreshOnFocus);
  document.removeEventListener("visibilitychange", refreshWhenVisible);
  clearTimeout(reconnect);
  for (const job of jobs.values()) job.abort();
  jobs.clear();
  engine.close();
  const closingPort = port;
  port = null;
  closingPort?.disconnect();
}, { once: true });
connect();
void trackWindowAttachment();
void refreshAvailability();
