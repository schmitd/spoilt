import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMemory } from "../core/memory";
import { MAX_DATA_URL_LENGTH, MAX_IMAGE_BYTES, validateNativeInput } from "../core/native-ai-protocol";
import { DEFAULT_SETTINGS } from "../core/settings";
import { AiClassifier } from "./ai-classifier";
import { CandidateCollector, promptImageInput } from "./dom";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn<(message: any) => Promise<unknown>>() }));
vi.mock("wxt/browser", () => ({ browser: { runtime: { sendMessage } } }));

// A real 2x1 JPEG fixture; jsdom substitutes only the browser's raster encoder.
const JPEG_BASE64 = "/9j/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCfAFV7f//Z";
const JPEG_BYTES = Uint8Array.from(atob(JPEG_BASE64), (value) => value.charCodeAt(0));
const drawImage = vi.fn();
let rasterCanvases: HTMLCanvasElement[];
let encodedBlob: Blob | null;

beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockImplementation(async (message: any) => message.input.kind === "capabilities"
    ? { ok: true, text: true, image: true }
    : { ok: true, decision: { block: true, rule: "Scene boundary" } });
  drawImage.mockReset();
  rasterCanvases = [];
  encodedBlob = new Blob([JPEG_BYTES], { type: "image/jpeg" });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback) {
    rasterCanvases.push(this);
    callback(encodedBlob);
  });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function canvas(width = 2048, height = 512): HTMLCanvasElement {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  element.style.opacity = "1";
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ width: 320, height: 80 } as DOMRect);
  document.body.append(element);
  return element;
}

function imageRequests() {
  return sendMessage.mock.calls.map(([message]) => message).filter((message) => message.input?.kind === "image");
}

async function classify(elements: Element[]) {
  const onMatch = vi.fn();
  await new AiClassifier().images(elements.map((element) => ({ element, metadataText: "" })),
    DEFAULT_SETTINGS, normalizeMemory(), onMatch, () => true);
  return onMatch;
}

describe("canvas vision serialization", () => {
  it("classifies every collected image beyond the former twelve-image cutoff", async () => {
    const elements = Array.from({ length: 15 }, () => canvas(100, 100));
    const onMatch = await classify(elements);
    expect(imageRequests()).toHaveLength(15);
    expect(onMatch).toHaveBeenCalledTimes(15);
  });

  it("sends a collected metadata-free canvas through the host using a bounded raster copy", async () => {
    const source = canvas();
    const candidates = new CandidateCollector().collectImages(DEFAULT_SETTINGS, "canvas-scan");
    expect(candidates).toEqual([{ element: source, metadataText: "" }]);
    expect(await promptImageInput(source)).toBe(source);
    const onMatch = vi.fn();

    await new AiClassifier().images(candidates, DEFAULT_SETTINGS, normalizeMemory(), onMatch, () => true);

    expect(imageRequests()).toHaveLength(1);
    const request = imageRequests()[0];
    expect(request.input.dataUrl).toBe(`data:image/jpeg;base64,${JPEG_BASE64}`);
    expect(validateNativeInput(request.input)).toBe(true);
    expect(rasterCanvases).toHaveLength(1);
    expect(rasterCanvases[0]).not.toBe(source);
    expect([rasterCanvases[0]!.width, rasterCanvases[0]!.height]).toEqual([1024, 256]);
    expect([source.width, source.height]).toEqual([2048, 512]);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 1024, 256);
    expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", .85);
    expect(onMatch).toHaveBeenCalledWith(candidates[0], expect.objectContaining({ ruleId: "local-ai-image" }));
  });

  it.each([
    [512, 2048, 256, 1024],
    [31, 17, 31, 17],
    [4096, 1, 1024, 1],
  ])("bounds %ix%i intrinsic pixels to %ix%i without enlarging small canvases", async (width, height, outputWidth, outputHeight) => {
    const source = canvas(width, height);
    await classify([source]);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, outputWidth, outputHeight);
    expect(imageRequests()).toHaveLength(1);
  });

  it.each([[0, 100], [100, 0], [0, 0]])("skips an empty %ix%i canvas", async (width, height) => {
    const onMatch = await classify([canvas(width, height)]);
    expect(drawImage).not.toHaveBeenCalled();
    expect(imageRequests()).toHaveLength(0);
    expect(onMatch).not.toHaveBeenCalled();
  });

  it("skips a missing drawing context and continues with the next candidate", async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null);
    const unreadable = canvas(), readable = canvas();
    const onMatch = await classify([unreadable, readable]);
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(readable, 0, 0, 1024, 256);
    expect(imageRequests()).toHaveLength(1);
    expect(onMatch).toHaveBeenCalledOnce();
  });

  it.each(["draw", "encode"])("keeps scanning after a %s SecurityError", async (stage) => {
    const unreadable = canvas(), readable = canvas();
    const fail = () => { throw new DOMException("Canvas is not origin-clean", "SecurityError"); };
    if (stage === "draw") drawImage.mockImplementationOnce(fail);
    else vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce(fail);

    const onMatch = await classify([unreadable, readable]);

    expect(imageRequests()).toHaveLength(1);
    expect(onMatch).toHaveBeenCalledOnce();
    expect(onMatch.mock.calls[0]![0].element).toBe(readable);
  });

  it("skips failed encoding and continues with the next candidate", async () => {
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce((callback) => callback(null));
    const unreadable = canvas(), readable = canvas();
    const onMatch = await classify([unreadable, readable]);
    expect(imageRequests()).toHaveLength(1);
    expect(onMatch.mock.calls[0]![0].element).toBe(readable);
  });

  it("skips FileReader errors and continues with the next candidate", async () => {
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementationOnce(function (this: FileReader) {
      this.dispatchEvent(new ProgressEvent("error"));
    });
    const unreadable = canvas(), readable = canvas();
    const onMatch = await classify([unreadable, readable]);
    expect(imageRequests()).toHaveLength(1);
    expect(onMatch.mock.calls[0]![0].element).toBe(readable);
  });

  it("allows the byte ceiling while keeping the data URL within the bridge limit", async () => {
    encodedBlob = new Blob([new Uint8Array(MAX_IMAGE_BYTES)], { type: "image/jpeg" });
    await classify([canvas()]);
    expect(imageRequests()).toHaveLength(1);
    const input = imageRequests()[0].input;
    expect(atob(input.dataUrl.split(",")[1]).length).toBe(MAX_IMAGE_BYTES);
    expect(input.dataUrl.length).toBeLessThanOrEqual(MAX_DATA_URL_LENGTH);
    expect(validateNativeInput(input)).toBe(true);
  });

  it("rejects a raster exceeding the byte ceiling by one before reading it", async () => {
    encodedBlob = new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], { type: "image/jpeg" });
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
    const onMatch = await classify([canvas()]);
    expect(read).not.toHaveBeenCalled();
    expect(imageRequests()).toHaveLength(0);
    expect(onMatch).not.toHaveBeenCalled();
  });

  it("still serializes loaded image elements from their natural dimensions", async () => {
    const source = document.createElement("img");
    Object.defineProperties(source, {
      complete: { value: true }, naturalWidth: { value: 600 }, naturalHeight: { value: 1800 },
    });
    document.body.append(source);
    await classify([source]);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 341, 1024);
    expect(imageRequests()[0].input.dataUrl).toBe(`data:image/jpeg;base64,${JPEG_BASE64}`);
  });

  it.each([[false, 300, 100], [true, 0, 100]])("skips an image with complete=%s and natural size %ix%i", async (complete, naturalWidth, naturalHeight) => {
    const source = document.createElement("img");
    Object.defineProperties(source, {
      complete: { value: complete }, naturalWidth: { value: naturalWidth }, naturalHeight: { value: naturalHeight },
    });
    document.body.append(source);
    await classify([source]);
    expect(drawImage).not.toHaveBeenCalled();
    expect(imageRequests()).toHaveLength(0);
  });

  it("preserves genuine prefetched image Blobs without rasterizing them", async () => {
    const candidate = { element: canvas(), metadataText: "Thumbnail" };
    await new AiClassifier().prefetchedImages([{ candidate, blob: new Blob([JPEG_BYTES], { type: "image/jpeg" }) }],
      DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => true);
    expect(drawImage).not.toHaveBeenCalled();
    expect(imageRequests()[0].input).toEqual({ kind: "image", metadata: "Thumbnail", dataUrl: `data:image/jpeg;base64,${JPEG_BASE64}` });
  });

  it.each(["oversized", "non-image"])("preserves rejection of %s prefetched Blobs", async (kind) => {
    const blob = kind === "oversized"
      ? new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], { type: "image/jpeg" })
      : new Blob([JPEG_BYTES], { type: "text/html" });
    await new AiClassifier().prefetchedImages([{ candidate: { element: canvas(), metadataText: "" }, blob }],
      DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => true);
    expect(drawImage).not.toHaveBeenCalled();
    expect(imageRequests()).toHaveLength(0);
  });

  it("discards canvas pixels if the scan changes while encoding", async () => {
    let current = true;
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce((callback) => {
      current = false;
      callback(encodedBlob);
    });
    await new AiClassifier().images([{ element: canvas(), metadataText: "" }], DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => current);
    expect(imageRequests()).toHaveLength(0);
  });
});
