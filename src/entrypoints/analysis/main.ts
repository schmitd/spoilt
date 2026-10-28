import { browser } from "wxt/browser";
import { HOST_PORT, NATIVE_RETRY_KEY, validRequestId, validateNativeInput } from "../../core/native-ai-protocol";
import { loadSettings } from "../../platform/storage";
import { NativeAiEngine } from "../../services/native-ai-engine";
import "./style.css";

const engine = new NativeAiEngine();
const main = document.querySelector("main")!;
const connection = document.querySelector("#connection")!;
const jobs = new Map<string, AbortController>();
let port: Browser.runtime.Port | null = null;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let closed = false;
let preparing = false;
let reconnectDelay = 1000;
const eligible = new Map<string, boolean>();
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
      if (port !== next || !message || typeof message !== "object") return;
      const value = message as Record<string, unknown>;
      if (value.type === "connected") {
        reconnectDelay = 1000;
        (main as HTMLElement).dataset.nativeHost = "connected";
        connection.textContent = "Connected. Keep this tab open while browsing.";
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

async function refreshAvailability() {
  const settings = await loadSettings();
  for (const kind of ["text", "image"] as const) {
    const allowed = settings.useLocalAI && (kind === "text" || settings.useVision);
    const availability = allowed ? await engine.availability(kind) : "disabled";
    const state = document.querySelector(`#${kind}-state`)!;
    state.textContent = availability === "available" ? "Model installed. A successful local check is required to verify analysis."
      : availability === "downloadable" ? "A download is required. Choose Prepare to consent to Chrome's model download and a local readiness check."
      : availability === "downloading" ? "Chrome is downloading this model. You can retry preparation when it finishes."
      : availability === "disabled" ? "Enable on-device analysis in Manage boundaries to use this model."
      : "This model is unavailable in this Chrome profile. Keyword and description matching remain active.";
    eligible.set(kind, allowed && availability !== "unavailable");
    (document.querySelector(`#prepare-${kind}`) as HTMLButtonElement).disabled = preparing || !eligible.get(kind);
  }
}

for (const kind of ["text", "image"] as const) {
  document.querySelector(`#prepare-${kind}`)!.addEventListener("click", () => {
    if (preparing) return;
    if (jobs.size) {
      document.querySelector(`#${kind}-state`)!.textContent = "A page is being analyzed. Retry preparation after that check finishes.";
      return;
    }
    preparing = true;
    document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    const state = document.querySelector(`#${kind}-state`)!;
    state.textContent = "Preparing and verifying locally…";
    // No awaited work before prepare: create retains the button's user activation.
    void engine.prepare(kind, (progress) => { state.textContent = `Downloading: ${Math.round(progress * 100)}%.`; }).then((ready) => {
      if (ready) retryExistingPages();
      state.textContent = ready ? "Ready: a local readiness prompt succeeded. Keep this tab open while browsing."
        : "Preparation could not be verified. Keyword protection remains active. Chrome may not support this model on this device.";
    }).catch(() => {
      state.textContent = "Preparation could not finish. Keyword protection remains active. Reload this tab to retry.";
    }).finally(() => {
      preparing = false;
      for (const modelKind of ["text", "image"]) (document.querySelector(`#prepare-${modelKind}`) as HTMLButtonElement).disabled = !eligible.get(modelKind);
    });
  });
}

window.addEventListener("pagehide", () => {
  closed = true;
  clearTimeout(reconnect);
  for (const job of jobs.values()) job.abort();
  jobs.clear();
  engine.close();
  port?.disconnect();
});
connect();
void refreshAvailability();
