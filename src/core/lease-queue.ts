interface WaitingLease {
  requestId: string;
  ownerId: string;
  resolve: (leaseId: string) => void;
}

interface ActiveLease {
  leaseId: string;
  requestId: string;
  ownerId: string;
}

export class LeaseQueue {
  #active: ActiveLease | null = null;
  #waiting: WaitingLease[] = [];

  acquire(requestId: string, ownerId: string): Promise<string> {
    const active = this.#active;
    if (active?.requestId === requestId) return Promise.resolve(active.leaseId);
    const waiting = this.#waiting.find((item) => item.requestId === requestId);
    if (waiting) {
      return new Promise((resolve) => {
        const originalResolve = waiting.resolve;
        waiting.resolve = (leaseId) => {
          originalResolve(leaseId);
          resolve(leaseId);
        };
      });
    }
    return new Promise((resolve) => {
      this.#waiting.push({ requestId, ownerId, resolve });
      this.#advance();
    });
  }

  release(leaseId: string): boolean {
    if (this.#active?.leaseId !== leaseId) return false;
    this.#active = null;
    this.#advance();
    return true;
  }

  cancel(requestId: string): { cancelled: boolean; leaseId?: string } {
    const waitingIndex = this.#waiting.findIndex((item) => item.requestId === requestId);
    if (waitingIndex >= 0) {
      this.#waiting.splice(waitingIndex, 1);
      return { cancelled: true };
    }
    if (this.#active?.requestId !== requestId) return { cancelled: false };
    const leaseId = this.#active.leaseId;
    this.release(leaseId);
    return { cancelled: true, leaseId };
  }

  releaseOwner(ownerId: string): string | null {
    this.#waiting = this.#waiting.filter((item) => item.ownerId !== ownerId);
    if (this.#active?.ownerId !== ownerId) return null;
    const leaseId = this.#active.leaseId;
    this.release(leaseId);
    return leaseId;
  }

  get activeOwner(): string | null {
    return this.#active?.ownerId ?? null;
  }

  get waitingCount(): number {
    return this.#waiting.length;
  }

  #advance(): void {
    if (this.#active || !this.#waiting.length) return;
    const next = this.#waiting.shift();
    if (!next) return;
    const leaseId = crypto.randomUUID();
    this.#active = { leaseId, requestId: next.requestId, ownerId: next.ownerId };
    next.resolve(leaseId);
  }
}
