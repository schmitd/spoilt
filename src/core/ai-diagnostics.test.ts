import { describe, expect, it } from "vitest";
import { AiDiagnostics } from "./ai-diagnostics";

describe("local performance diagnostics", () => {
  it("retains only bounded numeric metadata and fixed labels", () => {
    const diagnostics = new AiDiagnostics();
    diagnostics.record({ kind: "text", phase: "inference", durationMs: 12.345, items: 18, outputCharacters: 2,
      sessionMode: "clone", outcome: "ok", prompt: "private synthetic text", url: "https://private.test", reason: "private" });
    expect(diagnostics.snapshot()).toEqual({ samples: [{ kind: "text", phase: "inference", durationMs: 12.3,
      items: 18, outputCharacters: 2, sessionMode: "clone", outcome: "ok" }] });
    diagnostics.record({ kind: "private synthetic text", phase: "inference", durationMs: 2 });
    diagnostics.record({ kind: "text", phase: "private synthetic text", durationMs: 2 });
    diagnostics.record({ kind: "text", phase: "inference", durationMs: Infinity });
    expect(diagnostics.snapshot().samples).toHaveLength(1);
  });

  it("bounds retention and returns copies", () => {
    const diagnostics = new AiDiagnostics();
    for (let i = 0; i < 200; i++) diagnostics.record({ kind: "text", phase: "total", durationMs: i });
    const snapshot = diagnostics.snapshot(); expect(snapshot.samples).toHaveLength(128);
    snapshot.samples[0]!.durationMs = 0;
    expect(diagnostics.snapshot().samples[0]!.durationMs).toBe(72);
  });
});
