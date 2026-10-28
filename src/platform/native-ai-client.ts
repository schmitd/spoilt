import { browser } from "wxt/browser";
import { NATIVE_SCOPE, validateNativeResponse, type NativeInput, type NativeResponse } from "../core/native-ai-protocol";

// Request IDs belong to this classifier instance. Reset cannot cancel another page's work.
export class NativeAiClient {
  #pending = new Map<string, () => void>();

  async request(input: NativeInput): Promise<NativeResponse> {
    const requestId = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout>;
    const cancellation = new Promise<NativeResponse>((resolve) => {
      const cancel = () => {
        void browser.runtime.sendMessage({ scope: NATIVE_SCOPE, type: "cancel", requestId }).catch(() => undefined);
        resolve({ ok: false, reason: "cancelled" });
      };
      this.#pending.set(requestId, cancel);
      timer = setTimeout(cancel, 26_000);
    });
    try {
      const response = await Promise.race([
        browser.runtime.sendMessage({ scope: NATIVE_SCOPE, type: "classify", requestId, input }),
        cancellation,
      ]);
      return validateNativeResponse(input, response) ? response : { ok: false, reason: "failed" };
    } catch {
      return { ok: false, reason: "unavailable" };
    } finally {
      clearTimeout(timer!);
      this.#pending.delete(requestId);
    }
  }

  reset(): void {
    for (const cancel of this.#pending.values()) cancel();
    this.#pending.clear();
  }
}
