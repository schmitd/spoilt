import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMemory } from "../core/memory";
import { DEFAULT_SETTINGS } from "../core/settings";
import { AiClassifier } from "./ai-classifier";

const { updateStatus } = vi.hoisted(() => ({
  updateStatus: vi.fn(async (_patch: Record<string, unknown>) => undefined),
}));

vi.mock("../platform/storage", () => ({ updateStatus }));
vi.mock("../platform/ai-lease", () => ({
  withAiLease: vi.fn(async (_kind: string, operation: () => Promise<unknown>) => operation()),
}));
vi.mock("wxt/browser", () => ({ browser: { runtime: { sendMessage: vi.fn() } } }));

describe("AiClassifier", () => {
  beforeEach(() => {
    updateStatus.mockClear();
  });

  it("queues recovery and retries a cancelled text request without surfacing an error", async () => {
    const firstSession = {
      prompt: vi.fn(async () => { throw new DOMException("The request was cancelled.", "AbortError"); }),
      destroy: vi.fn(),
    };
    const secondSession = {
      prompt: vi.fn(async () => '{"decisions":[{"i":0,"block":true,"rule":"Plot spoilers"}]}'),
      destroy: vi.fn(),
    };
    const create = vi.fn()
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession);
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn(async () => "available"),
      create,
    });

    const parent = document.createElement("p");
    const node = document.createTextNode("The finale reveals the winner.");
    parent.append(node);
    document.body.append(parent);
    const onMatch = vi.fn();

    await new AiClassifier().text(
      [{ node, text: node.data }],
      DEFAULT_SETTINGS,
      normalizeMemory(),
      onMatch,
      () => true,
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(firstSession.destroy).toHaveBeenCalledOnce();
    expect(onMatch).toHaveBeenCalledOnce();
    expect(updateStatus.mock.calls.some(([patch]) => (
      typeof patch.lastError === "string" && patch.lastError.includes("AbortError")
    ))).toBe(false);
  });
});
