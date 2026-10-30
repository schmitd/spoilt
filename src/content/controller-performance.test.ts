import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import { normalizeMemory } from "../core/memory";
import { ContentController } from "./controller";

const { loadSettings, updateStatus, text, images, storageChanged } = vi.hoisted(() => ({
  loadSettings: vi.fn(), updateStatus: vi.fn(async () => undefined), text: vi.fn(async () => undefined),
  images: vi.fn(async () => undefined), storageChanged: vi.fn(),
}));
vi.mock("wxt/browser", () => ({ browser: {
  runtime: { onMessage: { addListener: vi.fn() }, sendMessage: vi.fn(async () => null) },
  storage: { onChanged: { addListener: storageChanged }, local: { get: vi.fn(async () => ({})) } },
} }));
vi.mock("../platform/storage", () => ({ loadSettings, updateStatus }));
vi.mock("../services/memory-service", () => ({ loadMemory: async () => normalizeMemory() }));
vi.mock("./ai-classifier", () => ({ AiClassifier: class { text = text; images = images; reset = vi.fn(async () => undefined); } }));

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({ display: "block", visibility: "visible", opacity: "1" } as CSSStyleDeclaration);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 30 } as DOMRect);
});
afterEach(async () => {
  loadSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, enabled: false });
  for (const [changed] of storageChanged.mock.calls) changed({ "spoilt.settings": { newValue: {} } }, "sync");
  await vi.advanceTimersByTimeAsync(0);
  document.body.replaceChildren(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe("bounded scan continuation", () => {
  it.each(["text", "images", "neither"])("does not rescan indefinitely when the enabled pipeline is %s", async (mode) => {
    loadSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, memoryEnabled: false, rules: [], scanText: mode === "text", scanImages: mode === "images" });
    document.body.innerHTML = mode === "text" ? "<p>A synthetic semantic scene</p>" : '<canvas title="A synthetic semantic scene" width="100" height="100"></canvas>';
    const controller = new ContentController(); await controller.start();
    await vi.advanceTimersByTimeAsync(50);
    const writesAfterCompletion = updateStatus.mock.calls.length;
    if (mode === "neither") { expect(text).not.toHaveBeenCalled(); expect(images).not.toHaveBeenCalled(); }
    else expect(mode === "text" ? text : images).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(updateStatus).toHaveBeenCalledTimes(writesAfterCompletion);
    // An explicit scan must also finish, even though the other collector never started.
    await controller.scan();
  });
});
