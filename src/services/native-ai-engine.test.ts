import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import { normalizeMemory } from "../core/memory";
import sharp from "sharp";
import { NativeAiEngine, READINESS_IMAGE_DATA_URL } from "./native-ai-engine";

const { loadSettings, loadMemory, updateStatus } = vi.hoisted(() => ({
  loadSettings: vi.fn(), loadMemory: vi.fn(), updateStatus: vi.fn(async (_patch: Record<string, unknown>) => undefined),
}));
vi.mock("../platform/storage", () => ({ loadSettings, updateStatus }));
vi.mock("./memory-service", () => ({ loadMemory }));

beforeEach(() => {
  loadSettings.mockReset().mockResolvedValue(DEFAULT_SETTINGS);
  loadMemory.mockReset().mockResolvedValue(normalizeMemory());
  updateStatus.mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const input = { kind: "text" as const, texts: ["A scene from the next episode"] };
function mockModel(availability = "available", output = '{"decisions":[{"i":0,"block":true,"rule":"Story"}]}') {
  const session = { prompt: vi.fn(async (_input: unknown, _options?: unknown) => output), destroy: vi.fn() };
  const model = { availability: vi.fn(async () => availability), create: vi.fn(async () => session) };
  vi.stubGlobal("LanguageModel", model);
  return { model, session };
}

describe("native Window inference engine", () => {
  it.each(["downloadable", "downloading", "unavailable"])("never creates or downloads a model during passive scans: %s", async (availability) => {
    const { model } = mockModel(availability);
    expect(await new NativeAiEngine().classify(input, new AbortController().signal)).toEqual({ ok: false, reason: "unavailable" });
    expect(model.create).not.toHaveBeenCalled();
    expect(updateStatus.mock.calls.some(([patch]) => patch.aiText === "available")).toBe(false);
  });

  it("checks capability without creating a session", async () => {
    const { model } = mockModel();
    expect(await new NativeAiEngine().classify({ kind: "capabilities" }, new AbortController().signal)).toEqual({ ok: true, text: true, image: true });
    expect(model.create).not.toHaveBeenCalled();
  });

  it("uses stored boundaries and destroys sessions after successful classification", async () => {
    const { model, session } = mockModel();
    const response = await new NativeAiEngine().classify(input, new AbortController().signal);
    expect(response).toMatchObject({ ok: true, decisions: [{ i: 0, block: true }] });
    expect(JSON.stringify(model.create.mock.calls[0])).toContain("Plot spoilers");
    expect(session.prompt.mock.calls[0]?.[0]).not.toContain("Plot spoilers");
    expect(model.create).toHaveBeenCalledOnce();
    expect(session.destroy).toHaveBeenCalledOnce();
    expect(updateStatus.mock.calls.some(([patch]) => patch.aiText === "available")).toBe(true);
  });

  it.each([{ enabled: false }, { useLocalAI: false }])("honors settings loaded in the extension context: %j", async (patch) => {
    const { model } = mockModel();
    loadSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, ...patch });
    expect(await new NativeAiEngine().classify(input, new AbortController().signal)).toEqual({ ok: false, reason: "unavailable" });
    expect(model.create).not.toHaveBeenCalled();
  });

  it("honors the stored vision setting for capabilities and image classification", async () => {
    const { model } = mockModel();
    loadSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, useVision: false });
    const engine = new NativeAiEngine();
    expect(await engine.classify({ kind: "capabilities" }, new AbortController().signal)).toMatchObject({ ok: true, image: false });
    expect(await engine.classify({ kind: "image", metadata: "", dataUrl: "data:image/png;base64,AAAA" }, new AbortController().signal)).toEqual({ ok: false, reason: "unavailable" });
    expect(model.create).not.toHaveBeenCalled();
  });

  it("destroys a session whose creation completes after cancellation", async () => {
    const { model, session } = mockModel();
    let complete!: (created: typeof session) => void;
    model.create.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const controller = new AbortController();
    const work = new NativeAiEngine().classify(input, controller.signal);
    await vi.waitFor(() => expect(model.create).toHaveBeenCalledOnce());
    controller.abort();
    expect(await work).toEqual({ ok: false, reason: "cancelled" });
    complete(session);
    await Promise.resolve();
    expect(session.destroy).toHaveBeenCalledOnce();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("aborts a pending prompt and destroys its session without reporting ready", async () => {
    const { session } = mockModel();
    session.prompt.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const work = new NativeAiEngine().classify(input, controller.signal);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    controller.abort();
    expect(await work).toEqual({ ok: false, reason: "cancelled" });
    expect(session.destroy).toHaveBeenCalledOnce();
    expect(updateStatus.mock.calls.some(([patch]) => patch.aiText === "available")).toBe(false);
  });

  it("bounds availability calls with the request cancellation signal", async () => {
    const { model } = mockModel();
    model.availability.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const work = new NativeAiEngine().classify(input, controller.signal);
    await vi.waitFor(() => expect(model.availability).toHaveBeenCalledOnce());
    controller.abort();
    expect(await work).toEqual({ ok: false, reason: "cancelled" });
    expect(model.create).not.toHaveBeenCalled();
  });

  it("recovers once from a cancelled native session", async () => {
    const { model, session } = mockModel();
    const failed = { prompt: vi.fn(async () => { throw new DOMException("Cancelled", "AbortError"); }), destroy: vi.fn() };
    model.create.mockResolvedValueOnce(failed);
    expect(await new NativeAiEngine().classify(input, new AbortController().signal)).toMatchObject({ ok: true });
    expect(model.create).toHaveBeenCalledTimes(2);
    expect(failed.destroy).toHaveBeenCalledOnce();
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it.each(['{"decisions":[{"i":99,"block":true}]}', '{"decisions":[{"i":0,"block":"true"}]}'])("rejects malformed model decisions: %s", async (output) => {
    mockModel("available", output);
    expect(await new NativeAiEngine().classify(input, new AbortController().signal)).toEqual({ ok: false, reason: "failed" });
  });
});

function cloneableModel(output = '{"decisions":[]}') {
  const clones: ReturnType<typeof disposable>[] = [];
  const baselines: ReturnType<typeof baselineSession>[] = [];
  function disposable() {
    return { prompt: vi.fn(async (_input: unknown, _options?: unknown) => output), destroy: vi.fn() };
  }
  function baselineSession() {
    return { ...disposable(), clone: vi.fn(async () => { const clone = disposable(); clones.push(clone); return clone; }) };
  }
  const model = {
    availability: vi.fn(async () => "available"),
    create: vi.fn(async (_options?: LanguageModelCreateOptions) => {
      const baseline = baselineSession();
      baselines.push(baseline);
      return baseline;
    }),
  };
  vi.stubGlobal("LanguageModel", model);
  return { model, baselines, clones, disposable };
}

describe("independent sessions from a pristine baseline", () => {
  it("creates one fixed-context baseline and destroys independent page clones", async () => {
    const { model, baselines, clones } = cloneableModel();
    const engine = new NativeAiEngine();
    await engine.classify(input, new AbortController().signal);
    await engine.classify({ kind: "text", texts: ["A different harmless page"] }, new AbortController().signal);
    expect(model.create).toHaveBeenCalledOnce();
    expect(baselines[0]!.clone).toHaveBeenCalledTimes(2);
    expect(baselines[0]!.prompt).not.toHaveBeenCalled();
    expect(baselines[0]!.destroy).not.toHaveBeenCalled();
    const fixed = JSON.stringify(model.create.mock.calls[0]);
    expect(fixed).toContain("Plot spoilers");
    expect(model.create.mock.calls[0]![0]!.initialPrompts).toMatchObject([
      { role: "system" }, { role: "user", content: expect.stringContaining("Plot spoilers") }, { role: "assistant" },
    ]);
    expect((model.create.mock.calls[0]![0]!.initialPrompts[0] as { content: string }).content).not.toContain("Plot spoilers");
    expect(fixed).not.toContain(input.texts[0]);
    expect(fixed).not.toContain("A different harmless page");
    expect(clones[0]!.prompt.mock.calls[0]![0]).toContain(input.texts[0]);
    expect(clones[1]!.prompt.mock.calls[0]![0]).not.toContain(input.texts[0]);
    for (const clone of clones) expect(clone.destroy).toHaveBeenCalledOnce();
    engine.close();
    expect(baselines[0]!.destroy).toHaveBeenCalledOnce();
  });

  it.each(["settings", "memory"])("replaces a baseline after %s changes", async (changed) => {
    const { model, baselines } = cloneableModel();
    const engine = new NativeAiEngine();
    await engine.classify(input, new AbortController().signal);
    if (changed === "settings") loadSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, strictness: "strict" });
    else loadMemory.mockResolvedValue({ ...normalizeMemory(), lastUpdatedAt: "2026-10-30T00:00:00Z" });
    await engine.classify(input, new AbortController().signal);
    expect(model.create).toHaveBeenCalledTimes(2);
    expect(baselines[0]!.destroy).toHaveBeenCalledOnce();
    expect(baselines[1]!.destroy).not.toHaveBeenCalled();
    engine.close();
  });

  it("releases retained sessions when protection is disabled", async () => {
    const { model, baselines } = cloneableModel();
    const engine = new NativeAiEngine();
    await engine.classify(input, new AbortController().signal);
    loadSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, useLocalAI: false });
    expect(await engine.classify(input, new AbortController().signal)).toEqual({ ok: false, reason: "unavailable" });
    expect(model.create).toHaveBeenCalledOnce();
    expect(baselines[0]!.destroy).toHaveBeenCalledOnce();
    engine.close();
  });

  it("keeps separate pristine baselines for text and image inputs", async () => {
    const { model, baselines, clones } = cloneableModel('{"decisions":[],"block":false}');
    const engine = new NativeAiEngine();
    await engine.classify(input, new AbortController().signal);
    await engine.classify({ kind: "image", metadata: "synthetic square", dataUrl: READINESS_IMAGE_DATA_URL }, new AbortController().signal);
    await engine.classify(input, new AbortController().signal);
    expect(model.create).toHaveBeenCalledTimes(2);
    expect(baselines[0]!.clone).toHaveBeenCalledTimes(2);
    expect(baselines[1]!.clone).toHaveBeenCalledOnce();
    expect(model.create.mock.calls[1]![0]!.expectedInputs).toContainEqual({ type: "image" });
    expect(clones[1]!.prompt.mock.calls[0]![0]).toMatchObject([{ role: "user", content: [{ type: "text", value: expect.stringContaining("synthetic square") }, { type: "image" }] }]);
    engine.close();
  });

  it("uses disposable sessions on Chrome versions without clone", async () => {
    const { model, session } = mockModel("available", '{"decisions":[]}');
    const engine = new NativeAiEngine();
    await engine.classify(input, new AbortController().signal);
    await engine.classify(input, new AbortController().signal);
    expect(model.create).toHaveBeenCalledTimes(2);
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(session.destroy).toHaveBeenCalledTimes(2);
    engine.close();
  });

  it("falls back once when clone is exposed but unsupported", async () => {
    const { model, session } = mockModel("available", '{"decisions":[]}');
    const baseline = { prompt: vi.fn(), destroy: vi.fn(), clone: vi.fn(async () => { throw new DOMException("Unsupported", "NotSupportedError"); }) };
    model.create.mockResolvedValueOnce(baseline);
    const engine = new NativeAiEngine();
    expect(await engine.classify(input, new AbortController().signal)).toEqual({ ok: true, decisions: [] });
    expect(await engine.classify(input, new AbortController().signal)).toEqual({ ok: true, decisions: [] });
    expect(model.create).toHaveBeenCalledTimes(3);
    expect(baseline.clone).toHaveBeenCalledOnce();
    expect(baseline.prompt).not.toHaveBeenCalled();
    expect(baseline.destroy).toHaveBeenCalledOnce();
    expect(session.destroy).toHaveBeenCalledTimes(2);
    engine.close();
  });

  it("recreates a Chrome-invalidated baseline before retrying", async () => {
    const { model, baselines } = cloneableModel();
    const engine = new NativeAiEngine();
    await engine.classify(input, new AbortController().signal);
    baselines[0]!.clone.mockRejectedValueOnce(new DOMException("Lost", "InvalidStateError"));
    expect(await engine.classify(input, new AbortController().signal)).toEqual({ ok: true, decisions: [] });
    expect(model.create).toHaveBeenCalledTimes(2);
    expect(baselines[0]!.destroy).toHaveBeenCalledOnce();
    engine.close();
  });

  it("destroys a late clone after request cancellation and retains only its pristine baseline", async () => {
    const { model, baselines, disposable } = cloneableModel();
    const engine = new NativeAiEngine();
    await engine.classify(input, new AbortController().signal);
    const late = disposable();
    let complete!: (session: typeof late) => void;
    baselines[0]!.clone.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const controller = new AbortController();
    const work = engine.classify(input, controller.signal);
    await vi.waitFor(() => expect(baselines[0]!.clone).toHaveBeenCalledTimes(2));
    controller.abort();
    expect(await work).toEqual({ ok: false, reason: "cancelled" });
    complete(late);
    await Promise.resolve();
    expect(late.destroy).toHaveBeenCalledOnce();
    expect(late.prompt).not.toHaveBeenCalled();
    expect(baselines[0]!.destroy).not.toHaveBeenCalled();
    await engine.classify(input, new AbortController().signal);
    expect(model.create).toHaveBeenCalledOnce();
    engine.close();
  });

  it("cancels a page prompt without retaining its history or losing the pristine baseline", async () => {
    const { model, baselines, clones, disposable } = cloneableModel();
    const engine = new NativeAiEngine();
    await engine.classify(input, new AbortController().signal);
    const hung = disposable();
    hung.prompt.mockImplementation(() => new Promise(() => undefined));
    baselines[0]!.clone.mockResolvedValueOnce(hung);
    const controller = new AbortController();
    const work = engine.classify({ kind: "text", texts: ["Cancelled page content"] }, controller.signal);
    await vi.waitFor(() => expect(hung.prompt).toHaveBeenCalledOnce());
    controller.abort();
    expect(await work).toEqual({ ok: false, reason: "cancelled" });
    expect(hung.destroy).toHaveBeenCalledOnce();
    expect(baselines[0]!.destroy).not.toHaveBeenCalled();
    await engine.classify(input, new AbortController().signal);
    expect(model.create).toHaveBeenCalledOnce();
    expect(clones[1]!.prompt.mock.calls[0]![0]).not.toContain("Cancelled page content");
    engine.close();
  });

  it("invalidates pending operations and destroys late clones", async () => {
    const { model, baselines, disposable } = cloneableModel();
    const engine = new NativeAiEngine();
    await engine.classify(input, new AbortController().signal);
    const late = disposable();
    let complete!: (session: typeof late) => void;
    baselines[0]!.clone.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const work = engine.classify(input, new AbortController().signal);
    await vi.waitFor(() => expect(baselines[0]!.clone).toHaveBeenCalledTimes(2));
    engine.invalidate();
    expect(await work).toEqual({ ok: false, reason: "cancelled" });
    complete(late);
    await Promise.resolve();
    expect(late.destroy).toHaveBeenCalledOnce();
    expect(baselines[0]!.destroy).toHaveBeenCalledOnce();
    await engine.classify(input, new AbortController().signal);
    expect(model.create).toHaveBeenCalledTimes(2);
    engine.close();
  });

  it("never adopts a baseline whose creation completes after invalidation", async () => {
    const { model, baselines, disposable } = cloneableModel();
    const engine = new NativeAiEngine();
    await engine.classify(input, new AbortController().signal);
    const late = { ...disposable(), clone: vi.fn(async () => disposable()) };
    engine.invalidate();
    let complete!: (session: typeof late) => void;
    model.create.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const work = engine.classify(input, new AbortController().signal);
    await vi.waitFor(() => expect(model.create).toHaveBeenCalledTimes(2));
    engine.invalidate();
    expect(await work).toEqual({ ok: false, reason: "cancelled" });
    complete(late);
    await Promise.resolve();
    expect(late.destroy).toHaveBeenCalledOnce();
    expect(late.clone).not.toHaveBeenCalled();
    expect(baselines[0]!.destroy).toHaveBeenCalledOnce();
    await engine.classify(input, new AbortController().signal);
    expect(model.create).toHaveBeenCalledTimes(3);
    engine.close();
  });

  it("closes an active page clone and cancels queued work without another create", async () => {
    const { model, baselines, disposable } = cloneableModel();
    const engine = new NativeAiEngine();
    await engine.classify(input, new AbortController().signal);
    const hung = disposable();
    hung.prompt.mockImplementation(() => new Promise(() => undefined));
    baselines[0]!.clone.mockResolvedValueOnce(hung);
    const active = engine.classify(input, new AbortController().signal);
    await vi.waitFor(() => expect(hung.prompt).toHaveBeenCalledOnce());
    const queued = engine.classify(input, new AbortController().signal);
    engine.close();
    expect(await active).toEqual({ ok: false, reason: "cancelled" });
    expect(await queued).toEqual({ ok: false, reason: "cancelled" });
    expect(hung.destroy).toHaveBeenCalledOnce();
    expect(baselines[0]!.destroy).toHaveBeenCalledOnce();
    expect(model.create).toHaveBeenCalledOnce();
  });

  it("expires idle baselines and permanently releases the engine on close", async () => {
    vi.useFakeTimers();
    const { model, baselines } = cloneableModel();
    const engine = new NativeAiEngine();
    await engine.classify(input, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(baselines[0]!.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(baselines[0]!.destroy).toHaveBeenCalledOnce();
    await engine.classify(input, new AbortController().signal);
    expect(model.create).toHaveBeenCalledTimes(2);
    engine.close();
    expect(baselines[1]!.destroy).toHaveBeenCalledOnce();
    expect(await engine.classify(input, new AbortController().signal)).toEqual({ ok: false, reason: "cancelled" });
    expect(await engine.prepare("text", vi.fn())).toBe(false);
    expect(model.create).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports only bounded phase metadata and ignores diagnostic callback errors", async () => {
    const { model } = cloneableModel();
    const events: unknown[] = [];
    const engine = new NativeAiEngine({ onDiagnostic: (event) => { events.push(event); throw new Error("Diagnostic sink failed"); } });
    expect(await engine.classify(input, new AbortController().signal)).toEqual({ ok: true, decisions: [] });
    expect(events).toContainEqual(expect.objectContaining({ phase: "session", kind: "text" }));
    expect(events).toContainEqual(expect.objectContaining({ phase: "clone", kind: "text" }));
    expect(events).toContainEqual(expect.objectContaining({ phase: "inference", sessionMode: "clone", items: 1, inputCharacters: input.texts[0]!.length, outputCharacters: 16 }));
    expect(events).toContainEqual(expect.objectContaining({ phase: "total", outcome: "ok" }));
    const encoded = JSON.stringify(events);
    expect(encoded).not.toContain(input.texts[0]);
    expect(encoded).not.toContain("Plot spoilers");
    expect(encoded).not.toContain(JSON.stringify(model.create.mock.calls[0]));
    engine.close();
  });

  it("cancels a stalled status write and releases the operation clone", async () => {
    const { clones } = cloneableModel();
    const engine = new NativeAiEngine();
    updateStatus.mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const work = engine.classify(input, controller.signal);
    await vi.waitFor(() => expect(clones[0]?.prompt).toHaveBeenCalledOnce());
    controller.abort();
    expect(await work).toEqual({ ok: false, reason: "cancelled" });
    expect(clones[0]!.destroy).toHaveBeenCalledOnce();
    engine.close();
  });

  it("keeps every synthetic snippet and positive index in the sparse decision contract", async () => {
    const { clones } = cloneableModel('{"decisions":[{"i":1,"block":true,"rule":"Plot spoilers","reason":"Ending revealed"}]}');
    const engine = new NativeAiEngine();
    const texts = ["A harmless weather report", "The captain survives the last battle", "A recipe for vegetable soup"];
    expect(await engine.classify({ kind: "text", texts }, new AbortController().signal)).toEqual({ ok: true, decisions: [{ i: 1, block: true, rule: "Plot spoilers", reason: "Ending revealed" }] });
    const prompt = clones[0]!.prompt.mock.calls[0]![0] as string;
    expect(prompt).toContain("Evaluate every snippet independently");
    expect(prompt).toContain('return {"decisions":[]}');
    expect(JSON.parse(prompt.split("Snippets:\n")[1]!)).toEqual(texts.map((text, i) => ({ i, text })));
    engine.close();
  });
});

describe("explicit model preparation", () => {
  it("releases a prepared session on close even if the initial status write stalls", async () => {
    const { session } = mockModel("downloadable", '{"ready":true}');
    updateStatus.mockImplementationOnce(() => new Promise(() => undefined));
    const engine = new NativeAiEngine();
    const work = engine.prepare("text", vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));
    engine.close();
    expect(await work).toBe(false);
    expect(session.destroy).toHaveBeenCalledOnce();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("retains ownership of a created session if the initial status write fails", async () => {
    const { session } = mockModel("downloadable", '{"ready":true}');
    updateStatus.mockRejectedValueOnce(new Error("Storage temporarily unavailable"));
    expect(await new NativeAiEngine().prepare("text", vi.fn())).toBe(true);
    expect(session.prompt).toHaveBeenCalledOnce();
    expect(session.destroy).toHaveBeenCalledOnce();
  });
  it("uses a valid local synthetic image for the vision readiness prompt", async () => {
    const { info } = await sharp(Buffer.from(READINESS_IMAGE_DATA_URL.split(",")[1]!, "base64")).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 1, height: 1 });
    const { session } = mockModel("downloadable", '{"ready":true}');
    expect(await new NativeAiEngine().prepare("image", vi.fn())).toBe(true);
    expect(session.prompt.mock.calls[0]?.[0]).toMatchObject([{ role: "user", content: [expect.any(Object), { type: "image", value: expect.any(Blob) }] }]);
  });
  it("calls create synchronously from the action and verifies an actual prompt before ready", async () => {
    const { model, session } = mockModel("downloadable", '{"ready":true}');
    const work = new NativeAiEngine().prepare("text", vi.fn());
    expect(model.create).toHaveBeenCalledOnce();
    expect(model.availability).not.toHaveBeenCalled();
    expect(await work).toBe(true);
    expect(session.prompt).toHaveBeenCalledOnce();
    expect(session.destroy).toHaveBeenCalledOnce();
    expect(updateStatus.mock.calls.some(([patch]) => patch.aiText === "available")).toBe(true);
  });

  it("does not label a merely created session ready when prompting fails", async () => {
    const { session } = mockModel("downloadable");
    session.prompt.mockRejectedValue(new Error("Inference unsupported"));
    expect(await new NativeAiEngine().prepare("text", vi.fn())).toBe(false);
    expect(updateStatus.mock.calls.some(([patch]) => patch.aiText === "available")).toBe(false);
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it("destroys late preparations when the analysis page closes", async () => {
    const { model, session } = mockModel("downloadable");
    let complete!: (created: typeof session) => void;
    model.create.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const engine = new NativeAiEngine();
    const work = engine.prepare("text", vi.fn());
    engine.close();
    expect(await work).toBe(false);
    complete(session);
    await Promise.resolve();
    expect(session.destroy).toHaveBeenCalledOnce();
    expect(session.prompt).not.toHaveBeenCalled();
  });
});
