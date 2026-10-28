import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMemory } from "../core/memory";
import { DEFAULT_SETTINGS } from "../core/settings";
import { AiClassifier } from "./ai-classifier";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn<(message: any) => Promise<unknown>>() }));
vi.mock("wxt/browser", () => ({ browser: { runtime: { sendMessage } } }));

beforeEach(() => { sendMessage.mockReset(); vi.stubGlobal("LanguageModel", undefined); });
afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); });

function candidate(text = "The captain quietly survives the battle") {
  document.body.innerHTML = "<p></p>";
  const node = document.createTextNode(text);
  document.querySelector("p")!.append(node);
  return { node, text };
}

describe("AiClassifier extension bridge", () => {
  it("classifies through the extension host when the content world has no LanguageModel", async () => {
    sendMessage.mockResolvedValue({ ok: true, decisions: [{ i: 0, block: true, rule: "Story" }] });
    const onMatch = vi.fn();
    await new AiClassifier().text([candidate()], DEFAULT_SETTINGS, normalizeMemory(), onMatch, () => true);
    expect(onMatch).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ scope: "spoilt-native", type: "classify", input: { kind: "text", texts: ["The captain quietly survives the battle"] } }));
  });

  it("discards responses after the source page changed", async () => {
    let finish!: (value: unknown) => void;
    sendMessage.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    let current = true;
    const onMatch = vi.fn();
    const work = new AiClassifier().text([candidate()], DEFAULT_SETTINGS, normalizeMemory(), onMatch, () => current);
    current = false;
    finish({ ok: true, decisions: [{ i: 0, block: true }] });
    await work;
    expect(onMatch).not.toHaveBeenCalled();
  });

  it("cancels an outstanding owned request on reset and ignores a late response", async () => {
    let finish!: (value: unknown) => void;
    sendMessage.mockImplementation((message: any) => message.type === "cancel"
      ? Promise.resolve({ ok: false, reason: "cancelled" }) : new Promise((resolve) => { finish = resolve; }));
    const classifier = new AiClassifier();
    const onMatch = vi.fn();
    const work = classifier.text([candidate()], DEFAULT_SETTINGS, normalizeMemory(), onMatch, () => true);
    await classifier.reset();
    await work;
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: "cancel" }));
    finish({ ok: true, decisions: [{ i: 0, block: true }] });
    await Promise.resolve();
    expect(onMatch).not.toHaveBeenCalled();
  });

  it("leaves direct protection active when no analysis host is open", async () => {
    sendMessage.mockResolvedValue({ ok: false, reason: "unavailable" });
    const onMatch = vi.fn();
    await new AiClassifier().text([candidate()], DEFAULT_SETTINGS, normalizeMemory(), onMatch, () => true);
    expect(onMatch).not.toHaveBeenCalled();
  });
});
