import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import { normalizeMemory } from "../core/memory";
import type { Settings } from "../core/types";
import { ContentController } from "./controller";

const { loadSettings, updateStatus, storageChanged, sendMessage } = vi.hoisted(() => ({
  loadSettings: vi.fn(), updateStatus: vi.fn(async () => undefined), storageChanged: vi.fn(), sendMessage: vi.fn(),
}));
vi.mock("wxt/browser", () => ({ browser: {
  runtime: { onMessage: { addListener: vi.fn() }, sendMessage },
  storage: { onChanged: { addListener: storageChanged }, local: { get: vi.fn(async () => ({})) } },
} }));
vi.mock("../platform/storage", () => ({ loadSettings, updateStatus }));
vi.mock("../services/memory-service", () => ({ loadMemory: async () => normalizeMemory() }));

let settings: Settings;
let stopRoutes = () => {};
function configured(): Settings {
  return { ...DEFAULT_SETTINGS, prefetchLinks: false, memoryEnabled: false, useVision: false,
    rules: [{ id: "story", name: "Original label", description: "", keywords: ["trigger"], enabled: true }] };
}
function changed(next: Settings): void {
  settings = next; loadSettings.mockResolvedValue(next);
  storageChanged.mock.calls.at(-1)![0]({ "spoilt.settings": { newValue: next } }, "sync");
}
function nativeCalls(type = "classify") {
  return sendMessage.mock.calls.filter(([message]) => message.scope === "spoilt-native" && message.type === type);
}
function reply(texts: string[]) {
  return { ok: true, decisions: texts.flatMap((text, i) => text.includes("captain") ? [{ i, block: true, ruleId: "story", rule: "Original label" }] : []) };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); settings = configured(); loadSettings.mockResolvedValue(settings);
  sendMessage.mockImplementation(async (message: any) => message.scope === "spoilt-native"
    ? message.type === "cancel" ? { ok: false, reason: "cancelled" } : reply(message.input.texts)
    : null);
  vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({ display: "block", visibility: "visible", opacity: "1" } as CSSStyleDeclaration);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 0, left: 0, right: 100, bottom: 30, width: 100, height: 30 } as DOMRect);
  const routes = vi.spyOn(window, "addEventListener");
  stopRoutes = () => { for (const [name, listener, options] of routes.mock.calls) window.removeEventListener(name, listener, options); };
});
afterEach(async () => {
  settings = { ...settings, enabled: false }; loadSettings.mockResolvedValue(settings);
  for (const [listener] of storageChanged.mock.calls) listener({ "spoilt.settings": { newValue: settings } }, "sync");
  await vi.advanceTimersByTimeAsync(0); stopRoutes();
  document.body.replaceChildren(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe("filter labels in the content runtime", () => {
  it("leaves title-only text and image metadata visible while explicit keywords still conceal both", async () => {
    settings = { ...configured(), useLocalAI: false,
      rules: [{ id: "story", name: "Galactic finale", description: "Accounting rates", keywords: [], enabled: true }] };
    loadSettings.mockResolvedValue(settings);
    document.body.innerHTML = '<p>Galactic finale</p><img src="https://example.com/scene.png" alt="Galactic finale">';
    const controller = new ContentController(); await controller.start(); await vi.advanceTimersByTimeAsync(50);
    expect(document.querySelectorAll(".spoilt-redacted-text,.spoilt-image-shell")).toHaveLength(0);
    changed({ ...settings, rules: [{ ...settings.rules[0]!, keywords: ["Galactic finale"] }] });
    await vi.advanceTimersByTimeAsync(50);
    expect(document.querySelectorAll(".spoilt-redacted-text")).toHaveLength(1);
    expect(document.querySelectorAll(".spoilt-image-shell")).toHaveLength(1);
    expect(nativeCalls()).toHaveLength(0);
  });

  it("ignores a prepared decision saved with the former title-derived signature", async () => {
    settings = { ...configured(), useLocalAI: false,
      rules: [{ id: "story", name: "Galactic finale", description: "Accounting rates", keywords: [], enabled: true }] };
    loadSettings.mockResolvedValue(settings);
    const memory = normalizeMemory();
    const oldSignature = JSON.stringify({ rules: settings.rules, strictness: settings.strictness, memory,
      enabled: settings.enabled, text: settings.scanText, images: settings.scanImages, ai: settings.useLocalAI, vision: settings.useVision });
    sendMessage.mockImplementation(async (message: any) => message.type === "getPrefetchAnalysis" ? [{
      kind: "live", url: location.href, signature: oldSignature, createdAt: Date.now(),
      matches: [{ text: "Galactic finale", match: { ruleId: "story", ruleName: "Galactic finale", reason: "Former title-derived decision" } }],
    }] : null);
    document.body.innerHTML = "<p>Galactic finale</p>";
    const controller = new ContentController(); await controller.start(); await vi.advanceTimersByTimeAsync(50);
    expect(document.querySelector(".spoilt-redacted-text")).toBeNull();
  });

  it("keeps direct, semantic and image masks through a rename and preserves positive/negative reuse", async () => {
    document.body.innerHTML = '<p id="direct">trigger direct detail</p><p id="semantic">The captain quietly survives the battle</p><p id="safe">Ordinary garden advice</p><img id="frame" src="https://example.com/scene.png" alt="trigger frame">';
    const controller = new ContentController(); await controller.start(); await vi.advanceTimersByTimeAsync(50);
    const direct = document.querySelector("#direct .spoilt-redacted-text")!;
    const semantic = document.querySelector("#semantic .spoilt-redacted-text")!;
    const image = document.querySelector(".spoilt-image-shell")!;
    expect(nativeCalls()).toHaveLength(1);
    changed({ ...settings, rules: [{ ...settings.rules[0]!, name: "Renamed label" }] });
    // The storage event updates presentation synchronously, without unmasking.
    expect(document.querySelector("#direct .spoilt-redacted-text")).toBe(direct);
    expect(document.querySelector("#semantic .spoilt-redacted-text")).toBe(semantic);
    expect(document.querySelector(".spoilt-image-shell")).toBe(image);
    expect([direct, semantic, image].every((element) => element.getAttribute("title")?.includes("Renamed label"))).toBe(true);
    expect(document.querySelector("#frame")?.getAttribute("alt")).toBe("trigger frame");
    await vi.advanceTimersByTimeAsync(0);
    document.querySelector("#semantic")!.replaceChildren(document.createTextNode("The captain quietly survives the battle"));
    document.querySelector("#safe")!.replaceChildren(document.createTextNode("Ordinary garden advice"));
    await vi.advanceTimersByTimeAsync(500);
    expect(document.querySelector("#semantic .spoilt-redacted-text")?.getAttribute("title")).toContain("Renamed label");
    expect(document.querySelector("#safe .spoilt-redacted-text")).toBeNull();
    expect(nativeCalls()).toHaveLength(1);
    expect(nativeCalls("cancel")).toHaveLength(0);
  });

  it("keeps pending inference across rename and labels its result with the latest name", async () => {
    let finish!: (value: unknown) => void;
    sendMessage.mockImplementation((message: any) => message.scope === "spoilt-native" && message.type === "classify"
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(null));
    document.body.innerHTML = "<p>The captain quietly survives the battle</p>";
    const controller = new ContentController(); await controller.start(); await vi.advanceTimersByTimeAsync(50);
    changed({ ...settings, rules: [{ ...settings.rules[0]!, name: "Renamed label" }] });
    finish({ ok: true, decisions: [{ i: 0, block: true, ruleId: "story", rule: "Original label" }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".spoilt-redacted-text")?.getAttribute("title")).toContain("Renamed label");
    expect(nativeCalls()).toHaveLength(1);
    expect(nativeCalls("cancel")).toHaveLength(0);
  });

  it("invalidates old inference immediately for a criteria change before its asynchronous reload finishes", async () => {
    let finish!: (value: unknown) => void; let reload!: (value: Settings) => void;
    sendMessage.mockImplementation((message: any) => message.scope === "spoilt-native" && message.type === "classify"
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(null));
    document.body.innerHTML = "<p>The captain quietly survives the battle</p>";
    const controller = new ContentController(); await controller.start(); await vi.advanceTimersByTimeAsync(50);
    const next = { ...settings, rules: [{ ...settings.rules[0]!, keywords: ["different criterion"] }] };
    loadSettings.mockImplementationOnce(() => new Promise((resolve) => { reload = resolve; }));
    storageChanged.mock.calls.at(-1)![0]({ "spoilt.settings": { newValue: next } }, "sync");
    finish({ ok: true, decisions: [{ i: 0, block: true, ruleId: "story" }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".spoilt-redacted-text")).toBeNull();
    expect(nativeCalls("cancel")).toHaveLength(1);
    settings = next; loadSettings.mockResolvedValue(next); reload(next);
    sendMessage.mockImplementation(async () => ({ ok: true, decisions: [] }));
    await vi.advanceTimersByTimeAsync(50);
    expect(document.querySelector(".spoilt-redacted-text")).toBeNull();
  });

  it("keeps the latest label when asynchronous rename reloads finish out of order", async () => {
    settings = { ...settings, useLocalAI: false }; loadSettings.mockResolvedValue(settings);
    document.body.innerHTML = "<p>trigger direct detail</p>";
    const controller = new ContentController(); await controller.start(); await vi.advanceTimersByTimeAsync(50);
    const mask = document.querySelector(".spoilt-redacted-text")!;
    let first!: (value: Settings) => void; let second!: (value: Settings) => void;
    const a = { ...settings, rules: [{ ...settings.rules[0]!, name: "First rename" }] };
    const b = { ...settings, rules: [{ ...settings.rules[0]!, name: "Latest rename" }] };
    loadSettings.mockImplementationOnce(() => new Promise((resolve) => { first = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { second = resolve; }));
    const listener = storageChanged.mock.calls.at(-1)![0];
    listener({ "spoilt.settings": { newValue: a } }, "sync");
    listener({ "spoilt.settings": { newValue: b } }, "sync");
    expect(mask.getAttribute("title")).toContain("Latest rename");
    second(b); await vi.advanceTimersByTimeAsync(0);
    first(a); await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".spoilt-redacted-text")).toBe(mask);
    expect(mask.getAttribute("title")).toContain("Latest rename");
    expect(nativeCalls()).toHaveLength(0);
    settings = b;
  });

  it("restores protection, unfinished scans and hover prefetch after a delayed criteria edit is reverted", async () => {
    settings = { ...configured(), prefetchLinks: true, scanImages: false }; loadSettings.mockResolvedValue(settings);
    document.body.innerHTML = '<p id="known">The captain quietly survives the battle</p><a id="next" href="/prefetch-after-revert">Read next article</a>';
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const addedListeners = vi.spyOn(document, "addEventListener");
    const fetchPage = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<p>trigger prefetched scene</p>", { headers: { "content-type": "text/html" } }));
    const controller = new ContentController(); await controller.start(); await vi.advanceTimersByTimeAsync(50);
    expect(document.querySelector("#known .spoilt-redacted-text")).toBeTruthy();
    expect(nativeCalls()).toHaveLength(1);

    const original = settings;
    const changedCriteria = { ...original, rules: [{ ...original.rules[0]!, keywords: ["different criterion"] }] };
    let finishOldReload!: (value: Settings) => void;
    loadSettings.mockImplementationOnce(() => new Promise((resolve) => { finishOldReload = resolve; }));
    storageChanged.mock.calls.at(-1)![0]({ "spoilt.settings": { newValue: changedCriteria } }, "sync");
    const pending = document.createElement("p"); pending.id = "unfinished"; pending.textContent = "The captain safely returns home"; document.body.append(pending);
    await vi.advanceTimersByTimeAsync(150);
    expect(nativeCalls()).toHaveLength(1);

    const latest = { ...original, rules: [{ ...original.rules[0]!, name: "Restored label" }] };
    changed(latest); await vi.advanceTimersByTimeAsync(50);
    expect(document.querySelector("#known .spoilt-redacted-text")?.getAttribute("title")).toContain("Restored label");
    expect(document.querySelector("#unfinished .spoilt-redacted-text")?.getAttribute("title")).toContain("Restored label");
    expect(nativeCalls()).toHaveLength(2);
    finishOldReload(changedCriteria); await vi.advanceTimersByTimeAsync(0);

    document.querySelector("#known")!.replaceChildren(document.createTextNode("The captain quietly survives the battle"));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector("#known .spoilt-redacted-text")?.getAttribute("title")).toContain("Restored label");
    const intent = addedListeners.mock.calls.filter(([name]) => name === "pointerover").at(-1)![1] as EventListener;
    intent({ isTrusted: true, target: document.querySelector("#next") } as unknown as Event);
    await vi.advanceTimersByTimeAsync(121);
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "savePrefetchAnalysis" }));
  });
});
