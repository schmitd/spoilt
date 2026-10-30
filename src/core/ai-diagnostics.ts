const phases = ["scheduling", "queue", "settings", "availability", "memory", "session", "clone", "inference", "total"] as const;
const kinds = ["text", "image", "capabilities"] as const;
const outcomes = ["ok", "failed", "cancelled", "unavailable", "busy"] as const;
interface Sample {
  kind: typeof kinds[number]; phase: typeof phases[number]; durationMs: number;
  items?: number; inputCharacters?: number; outputCharacters?: number;
  sessionMode?: "clone" | "disposable"; outcome?: typeof outcomes[number];
}

/** In-memory numeric diagnostics only. Never retains inputs, configuration, URLs or results. */
export class AiDiagnostics {
  #samples: Sample[] = [];

  record(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const input = value as Record<string, unknown>;
    if (!kinds.includes(input.kind as Sample["kind"]) || !phases.includes(input.phase as Sample["phase"])
      || typeof input.durationMs !== "number" || !Number.isFinite(input.durationMs) || input.durationMs < 0) return;
    const sample: Sample = { kind: input.kind as Sample["kind"], phase: input.phase as Sample["phase"],
      durationMs: Math.round(Math.min(input.durationMs, 300_000) * 10) / 10 };
    for (const key of ["items", "inputCharacters", "outputCharacters"] as const) {
      const count = input[key];
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) sample[key] = Math.min(10_000_000, Math.floor(count));
    }
    if (input.sessionMode === "clone" || input.sessionMode === "disposable") sample.sessionMode = input.sessionMode;
    const outcome = outcomes.find((outcome) => outcome === input.outcome);
    if (outcome) sample.outcome = outcome;
    this.#samples.push(sample);
    if (this.#samples.length > 128) this.#samples.shift();
  }

  snapshot(): { samples: Sample[] } { return { samples: this.#samples.map((sample) => ({ ...sample })) }; }
}
