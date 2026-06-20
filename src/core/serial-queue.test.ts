import { describe, expect, it } from "vitest";
import { SerialQueue } from "./serial-queue";

describe("SerialQueue", () => {
  it("runs tasks one at a time and continues after a rejection", async () => {
    const queue = new SerialQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = queue.run(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const failed = queue.run(async () => {
      events.push("failed:start");
      throw new Error("expected");
    });
    const last = queue.run(() => {
      events.push("last");
      return 3;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await first;
    await expect(failed).rejects.toThrow("expected");
    await expect(last).resolves.toBe(3);
    expect(events).toEqual(["first:start", "first:end", "failed:start", "last"]);
  });
});
