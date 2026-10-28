import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import { normalizeMemory } from "../core/memory";
import { NATIVE_RETRY_KEY } from "../core/native-ai-protocol";
import { ContentController } from "./controller";

const { text, addStorageListener } = vi.hoisted(() => ({ text: vi.fn(async () => undefined), addStorageListener: vi.fn() }));
vi.mock("wxt/browser", () => ({ browser: {
  runtime: { onMessage: { addListener: vi.fn() }, sendMessage: vi.fn(async () => null) },
  storage: { onChanged: { addListener: addStorageListener }, local: { get: vi.fn(async () => ({})) } },
} }));
vi.mock("../platform/storage", () => ({
  loadSettings: async () => ({ ...DEFAULT_SETTINGS, scanImages: false, memoryEnabled: false, rules: [] }), updateStatus: vi.fn(async () => undefined),
}));
vi.mock("../services/memory-service", () => ({ loadMemory: async () => normalizeMemory() }));
vi.mock("./ai-classifier", () => ({ AiClassifier: class {
  text = text; images = vi.fn(); reset = vi.fn(async () => undefined);
} }));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

describe("native setup retry", () => {
  it("rechecks a static candidate after setup without repeating on ordinary status writes", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({ display: "block", visibility: "visible", opacity: "1" } as CSSStyleDeclaration);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 30 } as DOMRect);
    document.body.innerHTML = "<p>A static scene from an upcoming episode</p>";
    const controller = new ContentController();
    await controller.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(text).toHaveBeenCalledOnce();

    await controller.scan();
    expect(text).toHaveBeenCalledOnce(); // Candidate was already collected while the host was missing.
    const changed = addStorageListener.mock.calls[0]![0] as (changes: Record<string, unknown>, area: string) => void;
    changed({ "spoilt.status": { newValue: { aiText: "available" } } }, "local");
    await vi.advanceTimersByTimeAsync(0);
    expect(text).toHaveBeenCalledOnce();

    changed({ [NATIVE_RETRY_KEY]: { newValue: "new-host-or-verified-model" } }, "local");
    await vi.advanceTimersByTimeAsync(0);
    expect(text).toHaveBeenCalledTimes(2);
    expect(document.querySelector("p")?.textContent).toBe("A static scene from an upcoming episode");
  });
});
