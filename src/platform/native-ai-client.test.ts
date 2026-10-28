import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeAiClient } from "./native-ai-client";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("wxt/browser", () => ({ browser: { runtime: { sendMessage } } }));
const input = { kind: "text" as const, texts: ["An unchanged semantic scene"] };

beforeEach(() => { vi.useFakeTimers(); sendMessage.mockReset(); vi.spyOn(Math, "random").mockReturnValue(0.5); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("NativeAiClient busy retry ownership", () => {
  it("settles immediately on reset during a retry delay and clears its timer", async () => {
    sendMessage.mockResolvedValue({ ok: false, reason: "busy" });
    const client = new NativeAiClient();
    const work = client.request(input);
    await vi.advanceTimersByTimeAsync(0);
    client.reset();
    await expect(work).resolves.toEqual({ ok: false, reason: "cancelled" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks the source generation before resubmitting a busy request", async () => {
    sendMessage.mockResolvedValue({ ok: false, reason: "busy" });
    let current = true;
    const work = new NativeAiClient().request(input, () => current);
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await vi.advanceTimersByTimeAsync(250);
    await expect(work).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["unavailable", "failed", "invalid", "cancelled"])("does not retry a %s response", async (reason) => {
    sendMessage.mockResolvedValue({ ok: false, reason });
    await expect(new NativeAiClient().request(input)).resolves.toEqual({ ok: false, reason });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
