import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMemory } from "../core/memory";
import { DEFAULT_SETTINGS } from "../core/settings";
import { AiClassifier } from "./ai-classifier";
import { Redactor } from "./dom";
import { ruleCriteriaKey } from "../core/rule-criteria";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn<(message: any) => Promise<unknown>>() }));
vi.mock("wxt/browser", () => ({ browser: { runtime: { sendMessage } } }));

beforeEach(() => { sendMessage.mockReset(); vi.stubGlobal("LanguageModel", undefined); });
afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

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

function appendCandidate(text: string) {
  const parent = document.createElement("p");
  const node = document.createTextNode(text); parent.append(node); document.body.append(parent);
  return { node, text };
}

describe("bounded local decision reuse", () => {
  it("deduplicates exact snippets and conceals every unchanged duplicate", async () => {
    sendMessage.mockResolvedValue({ ok: true, decisions: [{ i: 0, block: true, rule: "Story" }] });
    const diagnostics = vi.fn();
    const values = Array.from({ length: 3 }, () => appendCandidate("An identical synthetic ending"));
    const redactor = new Redactor();
    await new AiClassifier(undefined, diagnostics).text(values, DEFAULT_SETTINGS, normalizeMemory(),
      (value, match) => redactor.text(value, match, "whiteout", true), () => true);
    expect(sendMessage.mock.calls[0]![0].input.texts).toEqual([values[0]!.text]);
    expect(document.querySelectorAll(".spoilt-redacted-text")).toHaveLength(3);
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ batches: 1, duplicateCandidates: 2, cacheHits: 0 }));
    expect(Object.values(diagnostics.mock.calls[0]![0]).every((value) => typeof value === "number")).toBe(true);
  });

  it("does not conceal a changed or detached duplicate when its grouped response arrives", async () => {
    let finish!: (value: unknown) => void;
    sendMessage.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const values = Array.from({ length: 3 }, () => appendCandidate("An identical synthetic ending"));
    const redactor = new Redactor();
    const work = new AiClassifier().text(values, DEFAULT_SETTINGS, normalizeMemory(),
      (value, match) => redactor.text(value, match, "whiteout", true), () => true);
    values[0]!.node.data = "A changed safe gardening passage";
    values[1]!.node.parentElement!.remove();
    finish({ ok: true, decisions: [{ i: 0, block: true }] });
    await work;
    expect(document.querySelectorAll(".spoilt-redacted-text")).toHaveLength(1);
    expect(document.body.textContent).toContain("A changed safe gardening passage");
  });

  it("reuses exact positive and negative decisions for replacement nodes", async () => {
    sendMessage.mockResolvedValue({ ok: true, decisions: [{ i: 0, block: true }] });
    const classifier = new AiClassifier();
    const memory = normalizeMemory(); const onMatch = vi.fn();
    await classifier.text([appendCandidate("Synthetic matched ending"), appendCandidate("Synthetic safe gardening")], DEFAULT_SETTINGS, memory, onMatch, () => true);
    await classifier.text([appendCandidate("Synthetic matched ending"), appendCandidate("Synthetic safe gardening")], DEFAULT_SETTINGS, memory, onMatch, () => true);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(onMatch).toHaveBeenCalledTimes(2);
  });

  it("never deduplicates different full texts by a shared truncated prefix or caches a prefix negative", async () => {
    sendMessage.mockResolvedValue({ ok: true, decisions: [] });
    const classifier = new AiClassifier(); const prefix = "x".repeat(600);
    await classifier.text([appendCandidate(prefix + " first ending"), appendCandidate(prefix + " different ending")], DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => true);
    expect(sendMessage.mock.calls[0]![0].input.texts).toEqual([prefix, prefix]);
    await classifier.text([appendCandidate(prefix + " first ending")], DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it.each(["unavailable", "failed", "invalid", "cancelled"])("does not cache %s as a negative", async (reason) => {
    sendMessage.mockResolvedValueOnce({ ok: false, reason }).mockResolvedValue({ ok: true, decisions: [] });
    const classifier = new AiClassifier();
    await classifier.text([appendCandidate("Synthetic stable content")], DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => true);
    await classifier.text([appendCandidate("Synthetic stable content")], DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("expires cached negatives after one minute", async () => {
    let now = 1000; vi.spyOn(Date, "now").mockImplementation(() => now);
    sendMessage.mockResolvedValue({ ok: true, decisions: [] });
    const classifier = new AiClassifier();
    await classifier.text([appendCandidate("Synthetic stable content")], DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => true);
    now += 60_001;
    await classifier.text([appendCandidate("Synthetic stable content")], DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("releases cached text while idle without needing another lookup and clears expiry work on reset", async () => {
    vi.useFakeTimers();
    sendMessage.mockResolvedValue({ ok: true, decisions: [] });
    const classifier = new AiClassifier();
    await classifier.text([appendCandidate("Synthetic stable content")], DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => true);
    expect(classifier.cachedDecisionCount).toBe(1);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(classifier.cachedDecisionCount).toBe(0);
    await classifier.text([appendCandidate("Synthetic stable content")], DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => true);
    expect(classifier.cachedDecisionCount).toBe(1);
    await classifier.reset();
    expect(classifier.cachedDecisionCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("evicts the oldest entry beyond the 700-decision bound", async () => {
    sendMessage.mockResolvedValue({ ok: true, decisions: [] });
    const classifier = new AiClassifier();
    await classifier.text(Array.from({ length: 701 }, (_, index) => appendCandidate(`Synthetic stable content ${index}`)), DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => true);
    const batches = sendMessage.mock.calls.length;
    await classifier.text([appendCandidate("Synthetic stable content 0"), appendCandidate("Synthetic stable content 700")], DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => true);
    expect(sendMessage).toHaveBeenCalledTimes(batches + 1);
    expect(sendMessage.mock.calls.at(-1)![0].input.texts).toEqual(["Synthetic stable content 0"]);
  });

  it.each(["rules", "strictness", "memory", "route", "reset"])("invalidates decisions after %s changes", async (change) => {
    const oldUrl = location.href;
    sendMessage.mockResolvedValue({ ok: true, decisions: [] });
    const classifier = new AiClassifier();
    const memory = normalizeMemory(); let settings = { ...DEFAULT_SETTINGS };
    await classifier.text([appendCandidate("Synthetic stable content")], settings, memory, vi.fn(), () => true);
    if (change === "rules") settings = { ...settings, rules: [] };
    if (change === "strictness") settings = { ...settings, strictness: "strict" };
    if (change === "memory") {
      const rule = settings.rules[0]!;
      memory.ruleRuns[rule.id] = { criteriaKey: ruleCriteriaKey(rule), at: "", reason: "", query: "", resultCount: 1, imageExampleCount: 0 };
      memory.entries.push({ id: "synthetic", ruleId: rule.id, title: "A newly discovered synthetic ending", snippet: "A changed actual public detail", url: "https://example.com/story", source: "Synthetic", publishedAt: "", discoveredAt: "", terms: ["ending"], reason: "Synthetic" });
    }
    if (change === "route") history.replaceState(null, "", "#cache-route");
    if (change === "reset") await classifier.reset();
    try {
      await classifier.text([appendCandidate("Synthetic stable content")], settings, memory, vi.fn(), () => true);
      expect(sendMessage).toHaveBeenCalledTimes(2);
    } finally { history.replaceState(null, "", oldUrl); }
  });

  it("keeps positive and negative decisions across a label rename and resolves labels by stable rule id", async () => {
    const settings = { ...DEFAULT_SETTINGS, rules: [{ id: "story", name: "Original label", description: "Battle outcomes", keywords: [], enabled: true }] };
    const renamed = { ...settings, rules: [{ ...settings.rules[0]!, name: "Renamed label" }] };
    sendMessage.mockResolvedValue({ ok: true, decisions: [{ i: 0, block: true, ruleId: "story", rule: "Original label" }] });
    const classifier = new AiClassifier(); const onMatch = vi.fn();
    const values = ["A synthetic battle outcome", "Safe synthetic gardening"];
    await classifier.text(values.map(appendCandidate), settings, normalizeMemory(), onMatch, () => true);
    await classifier.text(values.map(appendCandidate), renamed, normalizeMemory(), onMatch, () => true);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(onMatch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ ruleId: "story", ruleName: "Renamed label" }));
  });

  it("keeps an in-flight request and applies its result using the latest label", async () => {
    const settings = { ...DEFAULT_SETTINGS, rules: [{ id: "story", name: "Original label", description: "Battle outcomes", keywords: [], enabled: true }] };
    let finish!: (value: unknown) => void;
    sendMessage.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const classifier = new AiClassifier(); const onMatch = vi.fn();
    const work = classifier.text([appendCandidate("A synthetic battle outcome")], settings, normalizeMemory(), onMatch, () => true);
    classifier.relabel([{ ...settings.rules[0]!, name: "Renamed label" }]);
    finish({ ok: true, decisions: [{ i: 0, block: true, ruleId: "story", rule: "Original label" }] });
    await work;
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(onMatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ruleId: "story", ruleName: "Renamed label" }));
  });

  it("attributes an in-flight image decision by stable rule id after a label rename", async () => {
    const settings = { ...DEFAULT_SETTINGS, rules: [{ id: "story", name: "Original label", description: "Battle outcomes", keywords: [], enabled: true }] };
    let finish!: (value: unknown) => void;
    sendMessage.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const element = document.createElement("img"); document.body.append(element);
    const classifier = new AiClassifier("speculative"); const onMatch = vi.fn();
    const work = classifier.prefetchedImages([{ candidate: { element, metadataText: "Synthetic scene" }, blob: new Blob(["synthetic pixels"], { type: "image/png" }) }], settings, normalizeMemory(), onMatch, () => true);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    classifier.relabel([{ ...settings.rules[0]!, name: "Renamed label" }]);
    finish({ ok: true, decision: { block: true, ruleId: "story", rule: "Original label" } });
    await work;
    expect(onMatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ruleId: "story", ruleName: "Renamed label" }));
  });

  it("does not populate the cache from an operation cancelled by reset", async () => {
    let finish!: (value: unknown) => void;
    sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue({ ok: true, decisions: [] });
    const classifier = new AiClassifier();
    const work = classifier.text([appendCandidate("Synthetic stable content")], DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => true);
    await classifier.reset(); await work;
    finish({ ok: true, decisions: [{ i: 0, block: true }] }); await Promise.resolve();
    const onMatch = vi.fn();
    await classifier.text([appendCandidate("Synthetic stable content")], DEFAULT_SETTINGS, normalizeMemory(), onMatch, () => true);
    expect(sendMessage.mock.calls.filter(([message]) => message.type === "classify")).toHaveLength(2);
    expect(onMatch).not.toHaveBeenCalled();
  });
});

describe("viewport scheduling", () => {
  function viewport(top: number): DOMRect { return { x: 0, y: top, top, left: 0, right: 100, bottom: top + 30, width: 100, height: 30, toJSON: () => ({}) }; }

  it("reprioritizes pending content after scrolling while still completing every snippet", async () => {
    const values = Array.from({ length: 54 }, (_, index) => appendCandidate(`Synthetic content ${index}`));
    let visible = values[0]!.node.parentElement;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return viewport(this === visible ? 0 : 2000); });
    sendMessage.mockImplementation(async () => { visible = values[53]!.node.parentElement; return { ok: true, decisions: [] }; });
    await new AiClassifier().text(values, DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => true);
    expect(sendMessage.mock.calls[0]![0].input.texts[0]).toBe(values[0]!.text);
    expect(sendMessage.mock.calls[1]![0].input.texts[0]).toBe(values[53]!.text);
    expect(sendMessage.mock.calls.flatMap(([message]) => message.input.texts).sort()).toEqual(values.map(({ text }) => text).sort());
  });

  it("gives an older offscreen candidate a FIFO batch within four busy foreground batches", async () => {
    const values = Array.from({ length: 90 }, (_, index) => appendCandidate(`Synthetic content ${index}`));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return viewport(this === values[0]!.node.parentElement ? 2000 : 0); });
    sendMessage.mockResolvedValue({ ok: true, decisions: [] });
    await new AiClassifier().text(values, DEFAULT_SETTINGS, normalizeMemory(), vi.fn(), () => true);
    expect(sendMessage.mock.calls.slice(0, 3).flatMap(([message]) => message.input.texts)).not.toContain(values[0]!.text);
    expect(sendMessage.mock.calls[3]![0].input.texts).toContain(values[0]!.text);
  });
});
