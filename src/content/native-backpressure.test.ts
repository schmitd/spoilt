import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_PORT, NATIVE_SCOPE, type NativeInput } from "../core/native-ai-protocol";
import { normalizeMemory } from "../core/memory";
import { DEFAULT_SETTINGS } from "../core/settings";
import { NativeAiBroker } from "../platform/native-ai-broker";
import { ContentController } from "./controller";

const { sendMessage, addStorageListener, loadSettings } = vi.hoisted(() => ({ sendMessage: vi.fn(), addStorageListener: vi.fn(), loadSettings: vi.fn() }));
vi.mock("wxt/browser", () => ({ browser: {
  runtime: { onMessage: { addListener: vi.fn() }, sendMessage },
  storage: { onChanged: { addListener: addStorageListener }, local: { get: vi.fn(async () => ({})) } },
} }));
vi.mock("../platform/storage", () => ({
  loadSettings,
  updateStatus: vi.fn(async () => undefined),
}));
vi.mock("../services/memory-service", () => ({ loadMemory: async () => normalizeMemory() }));

function event<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>();
  return {
    addListener: (listener: (...args: Args) => void) => { listeners.add(listener); },
    removeListener: (listener: (...args: Args) => void) => { listeners.delete(listener); },
    emit: (...args: Args) => { for (const listener of listeners) listener(...args); },
  };
}

function owner(tabId: number): Browser.runtime.MessageSender {
  return { id: "extension-id", frameId: 0, documentId: `document-${tabId}`, url: "https://example.com/article",
    tab: { id: tabId, url: "https://example.com/article" } as Browser.tabs.Tab };
}

let stopRouteListeners = () => {};
const settings = () => ({ ...DEFAULT_SETTINGS, scanImages: false, memoryEnabled: false, rules: [] });

beforeEach(() => {
  vi.useFakeTimers();
  sendMessage.mockReset();
  addStorageListener.mockReset();
  loadSettings.mockResolvedValue(settings());
  const routeListeners = vi.spyOn(window, "addEventListener");
  stopRouteListeners = () => {
    for (const [type, listener, options] of routeListeners.mock.calls) window.removeEventListener(type, listener, options);
  };
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({ display: "block", visibility: "visible", opacity: "1" } as CSSStyleDeclaration);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 30 } as DOMRect);
});
afterEach(async () => {
  loadSettings.mockResolvedValue({ ...settings(), enabled: false });
  for (const [changed] of addStorageListener.mock.calls) changed({ "spoilt.settings": { newValue: {} } }, "sync");
  await vi.advanceTimersByTimeAsync(0);
  stopRouteListeners();
  document.body.innerHTML = "";
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("native broker backpressure", () => {
  it("eventually conceals the rejected batch and every later collected batch after eight other documents release capacity", async () => {
    const hostUrl = "chrome-extension://extension-id/analysis.html";
    const broker = new NativeAiBroker({ runtimeId: "extension-id", hostUrl, reportUnavailable: vi.fn() });
    const messages = event<[unknown]>();
    let complete = false;
    const forwarded: Array<{ requestId: string; input: NativeInput }> = [];
    const port = {
      name: HOST_PORT,
      sender: { id: "extension-id", url: hostUrl, frameId: 0, tab: { id: 99, url: hostUrl } },
      onMessage: messages, onDisconnect: event<[]>(), disconnect: vi.fn(),
      postMessage: (message: { type: string; requestId: string; input: NativeInput }) => {
        if (message.type !== "classify") return;
        forwarded.push(message);
        if (complete && message.input.kind === "text") void Promise.resolve().then(() => messages.emit({
          type: "result", requestId: message.requestId,
          response: { ok: true, decisions: message.input.kind === "text" ? message.input.texts.map((_text, i) => ({ i, block: true })) : [] },
        }));
      },
    };
    broker.connect(port as unknown as Browser.runtime.Port);
    const occupied = Array.from({ length: 8 }, async (_, index) => {
      for (let batch = 0; batch < 2; batch++) await broker.handleMessage({
        scope: NATIVE_SCOPE, type: "classify", requestId: crypto.randomUUID(),
        input: { kind: "text", texts: [`Other document ${index}, batch ${batch}`] },
      }, owner(index));
    });
    sendMessage.mockImplementation(async (message: { scope: string }) => message.scope === NATIVE_SCOPE
      ? broker.handleMessage(message, owner(9)) : null);
    document.body.innerHTML = Array.from({ length: 40 }, (_, i) => `<p>Unchanged semantic scene number ${i}</p>`).join("");
    const controller = new ContentController();
    await controller.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(sendMessage.mock.calls.filter(([message]) => message.scope === NATIVE_SCOPE)).toHaveLength(1);
    expect(document.querySelectorAll(".spoilt-redacted-text")).toHaveLength(0);

    complete = true;
    for (const message of forwarded.slice()) messages.emit({ type: "result", requestId: message.requestId, response: { ok: true, decisions: [] } });
    await Promise.all(occupied);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(document.querySelectorAll(".spoilt-redacted-text")).toHaveLength(40);
    expect(forwarded.flatMap(({ input }) => input.kind === "text" ? input.texts.filter((text) => text.startsWith("Unchanged")) : [])).toEqual(
      Array.from({ length: 40 }, (_, i) => `Unchanged semantic scene number ${i}`));
    await controller.scan();
    expect(forwarded).toHaveLength(19);
    broker.invalidateSettings();
  });

  it("automatically retries only unfinished batches when capacity returns after the client retry budget", async () => {
    let busy = true;
    const submitted: string[][] = [];
    sendMessage.mockImplementation(async (message: { scope: string; input?: NativeInput }) => {
      if (message.scope !== NATIVE_SCOPE || message.input?.kind !== "text") return null;
      submitted.push(message.input.texts);
      if (busy && message.input.texts[0] !== "Unchanged semantic scene number 0") return { ok: false, reason: "busy" };
      return { ok: true, decisions: message.input.texts.map((_text, i) => ({ i, block: !busy })) };
    });
    document.body.innerHTML = Array.from({ length: 40 }, (_, i) => `<p>Unchanged semantic scene number ${i}</p>`).join("");
    const controller = new ContentController();
    await controller.start();
    await vi.advanceTimersByTimeAsync(50 + 27_750);
    expect(submitted).toHaveLength(12); // One completed batch, then eleven bounded busy attempts.
    expect(document.querySelectorAll(".spoilt-redacted-text")).toHaveLength(0);

    busy = false;
    await vi.advanceTimersByTimeAsync(1001);
    expect(submitted).toHaveLength(14);
    expect(document.querySelectorAll(".spoilt-redacted-text")).toHaveLength(22);
    expect(submitted.filter((texts) => texts[0] === "Unchanged semantic scene number 0")).toHaveLength(1);
    expect(submitted.slice(12).flat()).toEqual(Array.from({ length: 22 }, (_, i) => `Unchanged semantic scene number ${18 + i}`));
  });

  it("stops automatic work finitely when the broker stays busy and leaves unfinished text eligible", async () => {
    let busy = true;
    sendMessage.mockImplementation(async (message: { scope: string; input?: NativeInput }) => {
      if (message.scope !== NATIVE_SCOPE || message.input?.kind !== "text") return null;
      return busy ? { ok: false, reason: "busy" } : { ok: true, decisions: [{ i: 0, block: true }] };
    });
    document.body.innerHTML = "<p>A static scene that needs semantic analysis</p>";
    const controller = new ContentController();
    await controller.start();
    await vi.advanceTimersByTimeAsync(180_000);
    const attempts = sendMessage.mock.calls.filter(([message]) => message.scope === NATIVE_SCOPE).length;
    expect(attempts).toBe(44); // Four scans, each with one request and ten delayed retries.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sendMessage.mock.calls.filter(([message]) => message.scope === NATIVE_SCOPE)).toHaveLength(attempts);
    busy = false;
    await controller.scan();
    expect(document.querySelectorAll(".spoilt-redacted-text")).toHaveLength(1);
  });

  it.each(["capabilities", "image"])("automatically retries unfinished images after %s backpressure exhausts the client budget", async (kind) => {
    loadSettings.mockResolvedValue({ ...settings(), scanText: false, scanImages: true });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["bounded raster"], { type: "image/jpeg" })));
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      Object.defineProperty(this, "result", { value: "data:image/jpeg;base64,YQ==", configurable: true });
      this.dispatchEvent(new ProgressEvent("load"));
    });
    let busy = true;
    const submitted: string[] = [];
    sendMessage.mockImplementation(async (message: { scope: string; input?: NativeInput }) => {
      if (message.scope !== NATIVE_SCOPE || !message.input) return null;
      if (message.input.kind === "capabilities") return busy && kind === "capabilities"
        ? { ok: false, reason: "busy" } : { ok: true, text: true, image: true };
      if (message.input.kind !== "image") return null;
      submitted.push(message.input.metadata);
      if (busy && message.input.metadata !== "Frame 0") return { ok: false, reason: "busy" };
      return { ok: true, decision: { block: !busy } };
    });
    document.body.innerHTML = Array.from({ length: 3 }, (_, i) => `<canvas title="Frame ${i}" width="100" height="100"></canvas>`).join("");
    const controller = new ContentController();
    await controller.start();
    await vi.advanceTimersByTimeAsync(50 + 27_750);
    expect(document.querySelectorAll(".spoilt-image-shell")).toHaveLength(0);

    busy = false;
    await vi.advanceTimersByTimeAsync(1001);
    expect(document.querySelectorAll(".spoilt-image-shell")).toHaveLength(kind === "capabilities" ? 3 : 2);
    expect(submitted.filter((metadata) => metadata === "Frame 0")).toHaveLength(1);
  });

  it.each(["pause", "disable AI", "navigate"])("cancels a pending automatic retry on %s", async (change) => {
    sendMessage.mockImplementation(async (message: { scope: string }) => message.scope === NATIVE_SCOPE ? { ok: false, reason: "busy" } : null);
    document.body.innerHTML = "<p>A static scene that needs semantic analysis</p>";
    const controller = new ContentController();
    await controller.start();
    await vi.advanceTimersByTimeAsync(50 + 27_750);
    const attempts = sendMessage.mock.calls.filter(([message]) => message.scope === NATIVE_SCOPE).length;
    expect(attempts).toBe(11);
    if (change === "navigate") {
      document.body.innerHTML = "";
      window.history.replaceState(null, "", "#new-route");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } else {
      loadSettings.mockResolvedValue({ ...settings(), ...(change === "pause" ? { enabled: false } : { useLocalAI: false }) });
      addStorageListener.mock.calls[0]![0]({ "spoilt.settings": { newValue: {} } }, "sync");
    }
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sendMessage.mock.calls.filter(([message]) => message.scope === NATIVE_SCOPE)).toHaveLength(attempts);
  });
});
