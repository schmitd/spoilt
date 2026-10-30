import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeJobQueue, NativeQueueBusyError, type NativePriority } from "./native-job-queue";

afterEach(() => vi.useRealTimers());
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("NativeJobQueue", () => {
  it("runs one request at a time and favors foreground over queued speculation", async () => {
    const queue = new NativeJobQueue(); const order: string[] = [];
    let release!: () => void;
    const first = queue.run(() => new Promise<void>((resolve) => { release = resolve; }), { priority: "background", signal: new AbortController().signal });
    const add = (name: string, priority: NativePriority) => queue.run(async () => { order.push(name); }, { priority, signal: new AbortController().signal });
    const speculative = add("speculative", "speculative"); const foreground = add("foreground", "foreground");
    await flush(); expect(order).toEqual([]); release();
    await Promise.all([first, speculative, foreground]); expect(order).toEqual(["foreground", "speculative"]);
  });

  it("admits below-fold and speculative work during sustained foreground traffic", async () => {
    const queue = new NativeJobQueue(); const order: string[] = []; let release!: () => void;
    const first = queue.run(() => new Promise<void>((resolve) => { release = resolve; }), { priority: "foreground", signal: new AbortController().signal });
    const pending = [queue.run(async () => { order.push("below-fold"); }, { priority: "background", signal: new AbortController().signal }),
      queue.run(async () => { order.push("speculative"); }, { priority: "speculative", signal: new AbortController().signal }),
      ...Array.from({length: 12}, (_, index) => queue.run(async () => { order.push(`visible-${index}`); }, { priority: "foreground", signal: new AbortController().signal }))];
    await flush(); release(); await Promise.all([first, ...pending]);
    expect(order.indexOf("below-fold")).toBe(4); expect(order.indexOf("speculative")).toBeLessThanOrEqual(9);
  });

  it("expires queued work as busy without starting or consuming an execution timer", async () => {
    vi.useFakeTimers(); const queue = new NativeJobQueue(); let release!: () => void;
    const first = queue.run(() => new Promise<void>((resolve) => { release = resolve; }), { priority: "foreground", signal: new AbortController().signal });
    const task = vi.fn(async () => undefined); const onStart = vi.fn(); const onWait = vi.fn();
    const waiting = queue.run(task, { priority: "background", signal: new AbortController().signal, onStart, onWait });
    const assertion = expect(waiting).rejects.toBeInstanceOf(NativeQueueBusyError);
    await vi.advanceTimersByTimeAsync(4_000); await assertion;
    expect(task).not.toHaveBeenCalled(); expect(onStart).not.toHaveBeenCalled(); expect(onWait).toHaveBeenCalledOnce();
    release(); await first;
  });

  it("admits aged below-fold work before slow foreground turns exhaust its wait budget", async () => {
    vi.useFakeTimers(); const queue = new NativeJobQueue(); const order: string[] = [];
    const add = (name: string, priority: NativePriority) => queue.run(async () => {
      order.push(name); await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    }, { priority, signal: new AbortController().signal });
    const first = add("first", "foreground"); const below = add("below-fold", "background");
    const foreground = [add("visible-1", "foreground"), add("visible-2", "foreground")];
    await vi.advanceTimersByTimeAsync(1_100);
    expect(order).toEqual(["first", "below-fold"]);
    await vi.advanceTimersByTimeAsync(4_400); await Promise.all([first, below, ...foreground]);
  });

  it("removes cancelled queued work and continues after an execution failure", async () => {
    const queue = new NativeJobQueue(); let release!: () => void;
    const first = queue.run(() => new Promise<void>((resolve) => { release = resolve; }), { priority: "foreground", signal: new AbortController().signal });
    const controller = new AbortController(); const task = vi.fn(async () => 1);
    const cancelled = queue.run(task, { priority: "background", signal: controller.signal });
    const assertion = expect(cancelled).rejects.toMatchObject({ name: "AbortError" }); controller.abort(); await assertion;
    const failed = queue.run(async () => { throw new Error("synthetic"); }, { priority: "foreground", signal: new AbortController().signal });
    const failAssertion = expect(failed).rejects.toThrow("synthetic");
    const last = queue.run(async () => 2, { priority: "background", signal: new AbortController().signal });
    await flush(); release(); await first; await failAssertion; await expect(last).resolves.toBe(2); expect(task).not.toHaveBeenCalled();
  });
});
