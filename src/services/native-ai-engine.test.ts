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
afterEach(() => vi.unstubAllGlobals());

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
    expect(session.prompt.mock.calls[0]?.[0]).toContain("Plot spoilers");
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

describe("explicit model preparation", () => {
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
