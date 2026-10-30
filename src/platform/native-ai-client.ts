import { browser } from "wxt/browser";
import { NATIVE_SCOPE, validateNativeResponse, type NativeInput, type NativeResponse } from "../core/native-ai-protocol";
import type { NativePriority } from "../core/native-job-queue";

const MAX_BUSY_RETRIES = 10;

// Request IDs belong to this classifier instance. Reset cannot cancel another page's work.
export class NativeAiClient {
  #pending = new Map<string, () => void>();

  async request(input: NativeInput, isCurrent: () => boolean = () => true, priority: NativePriority = "background"): Promise<NativeResponse> {
    const requestId = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let inFlight = false;
    const cancellation = new Promise<NativeResponse>((resolve) => {
      const cancel = () => {
        cancelled = true;
        if (inFlight) void browser.runtime.sendMessage({ scope: NATIVE_SCOPE, type: "cancel", requestId }).catch(() => undefined);
        resolve({ ok: false, reason: "cancelled" });
      };
      this.#pending.set(requestId, cancel);
    });
    try {
      for (let attempt = 0; ; attempt++) {
        if (cancelled || !isCurrent()) return { ok: false, reason: "cancelled" };
        inFlight = true;
        timer = setTimeout(this.#pending.get(requestId)!, 26_000);
        const response = await Promise.race([
          browser.runtime.sendMessage({ scope: NATIVE_SCOPE, type: "classify", requestId, input, priority }),
          cancellation,
        ]);
        clearTimeout(timer);
        timer = undefined;
        inFlight = false;
        if (!validateNativeResponse(input, response)) return { ok: false, reason: "failed" };
        if (response.ok || response.reason !== "busy" || priority === "speculative" || attempt >= MAX_BUSY_RETRIES) return response;
        // Keep the rejected batch in its caller. Jitter spreads documents woken
        // together, and a finite budget prevents a permanently busy hot loop.
        const delay = Math.round(Math.min(250 * 2 ** attempt, 4000) * (0.75 + Math.random() / 2));
        await Promise.race([
          new Promise<void>((resolve) => { retryTimer = setTimeout(resolve, delay); }),
          cancellation,
        ]);
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    } catch {
      return { ok: false, reason: "unavailable" };
    } finally {
      clearTimeout(timer);
      clearTimeout(retryTimer);
      this.#pending.delete(requestId);
    }
  }

  reset(): void {
    for (const cancel of this.#pending.values()) cancel();
    this.#pending.clear();
  }
}
