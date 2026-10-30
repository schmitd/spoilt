export type NativePriority = "foreground" | "background" | "speculative";
const priorityValue = { foreground: 0, background: 1, speculative: 2 } as const;

export class NativeQueueBusyError extends Error {
  constructor() { super("Local analysis queue is busy."); this.name = "NativeQueueBusyError"; }
}

interface Job {
  priority: NativePriority;
  queuedAt: number;
  start: () => void;
  cancel: (busy?: boolean) => void;
}

/** Serial execution with foreground preference, bounded waiting and lower-priority progress. */
export class NativeJobQueue {
  #pending: Job[] = [];
  #active = false;
  #preferred = 0;

  run<T>(task: () => Promise<T>, options: {
    priority: NativePriority; signal: AbortSignal; onStart?: () => void; onWait?: (durationMs: number) => void;
  }): Promise<T> {
    if (options.signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
    return new Promise<T>((resolve, reject) => {
      const queuedAt = performance.now();
      let started = false;
      let settled = false;
      const cleanup = () => { clearTimeout(timer); options.signal.removeEventListener("abort", abort); };
      const reportWait = () => { try { options.onWait?.(Math.max(0, performance.now() - queuedAt)); } catch { /* Diagnostics cannot fail analysis. */ } };
      const job: Job = {
        priority: options.priority, queuedAt,
        cancel: (busy = false) => {
          if (started || settled) return;
          settled = true;
          this.#pending = this.#pending.filter((item) => item !== job);
          cleanup(); reportWait();
          reject(busy ? new NativeQueueBusyError() : new DOMException("Cancelled", "AbortError"));
        },
        start: () => {
          if (settled) return;
          started = true; cleanup(); reportWait();
          this.#active = true;
          Promise.resolve().then(() => {
            if (options.signal.aborted) throw new DOMException("Cancelled", "AbortError");
            options.onStart?.(); return task();
          }).then(resolve, reject).finally(() => {
            settled = true; this.#active = false; this.#drain();
          });
        },
      };
      const abort = () => job.cancel();
      // Leave the full 20-second execution budget inside the broker's 25-second bound.
      const timer = setTimeout(() => job.cancel(true), 4_000);
      options.signal.addEventListener("abort", abort, { once: true });
      this.#pending.push(job);
      if (options.signal.aborted) job.cancel();
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#active || !this.#pending.length) return;
    const best = Math.min(...this.#pending.map((job) => priorityValue[job.priority]));
    const lower = this.#pending.findIndex((job) => priorityValue[job.priority] > best);
    // A slow foreground request must not use up the lower-priority wait budget
    // before its reserved turn. Age wins after one second, or four quick turns.
    const index = lower >= 0 && (this.#preferred >= 4 || performance.now() - this.#pending[lower]!.queuedAt >= 1_000) ? lower
      : this.#pending.findIndex((job) => priorityValue[job.priority] === best);
    if (priorityValue[this.#pending[index]!.priority] > best || lower < 0) this.#preferred = 0;
    else this.#preferred += 1;
    this.#pending.splice(index, 1)[0]!.start();
  }
}
