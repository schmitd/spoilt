import { browser } from "wxt/browser";

const LEASE_WAIT_MS = 30_000;

export async function withAiLease<T>(kind: "text" | "image" | "prepare", operation: () => Promise<T>): Promise<T> {
  const requestId = crypto.randomUUID();
  let leaseId = "";
  try {
    const response = await withTimeout(
      browser.runtime.sendMessage({
        scope: "spoilt",
        type: "acquireAiLease",
        requestId,
        kind,
      }) as Promise<{ ok: boolean; leaseId?: string; error?: string }>,
      LEASE_WAIT_MS,
    );
    if (!response.ok || !response.leaseId) throw new Error(response.error || "On-device analysis is busy.");
    leaseId = response.leaseId;
    return await operation();
  } finally {
    if (leaseId) {
      await browser.runtime.sendMessage({ scope: "spoilt", type: "releaseAiLease", leaseId }).catch(() => undefined);
    } else {
      await browser.runtime.sendMessage({ scope: "spoilt", type: "cancelAiLease", requestId }).catch(() => undefined);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = globalThis.setTimeout(() => reject(new DOMException("Timed out waiting for on-device analysis.", "TimeoutError")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => globalThis.clearTimeout(timeoutId));
}
