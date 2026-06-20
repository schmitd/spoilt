import { describe, expect, it } from "vitest";
import { LeaseQueue } from "./lease-queue";

describe("LeaseQueue", () => {
  it("grants only one lease and advances in order", async () => {
    const queue = new LeaseQueue();
    const first = await queue.acquire("request-1", "tab-1");
    let secondGranted = false;
    const secondPromise = queue.acquire("request-2", "tab-2").then((lease) => {
      secondGranted = true;
      return lease;
    });

    await Promise.resolve();
    expect(secondGranted).toBe(false);
    expect(queue.activeOwner).toBe("tab-1");
    expect(queue.waitingCount).toBe(1);

    expect(queue.release(first)).toBe(true);
    const second = await secondPromise;
    expect(secondGranted).toBe(true);
    expect(queue.activeOwner).toBe("tab-2");
    expect(queue.release(second)).toBe(true);
  });

  it("removes queued and active work when an owner disappears", async () => {
    const queue = new LeaseQueue();
    await queue.acquire("request-1", "tab-1");
    const secondPromise = queue.acquire("request-2", "tab-2");
    queue.releaseOwner("tab-1");
    await expect(secondPromise).resolves.toEqual(expect.any(String));
    expect(queue.activeOwner).toBe("tab-2");
  });

  it("returns the active lease when cancellation needs timeout cleanup", async () => {
    const queue = new LeaseQueue();
    const leaseId = await queue.acquire("request-1", "tab-1");
    expect(queue.cancel("request-1")).toEqual({ cancelled: true, leaseId });
    expect(queue.activeOwner).toBeNull();
  });
});
