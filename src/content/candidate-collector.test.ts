import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import { CandidateCollector } from "./dom";

vi.mock("wxt/browser", () => ({ browser: { runtime: { sendMessage: vi.fn() } } }));

function rect(top: number): DOMRect {
  return { x: 0, y: top, top, left: 0, right: 100, bottom: top + 30, width: 100, height: 30, toJSON: () => ({}) };
}
function paragraph(text: string, visible = false): HTMLParagraphElement {
  const element = document.createElement("p"); element.textContent = text;
  element.dataset.visible = String(visible); document.body.append(element); return element;
}

beforeEach(() => {
  vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({ display: "block", visibility: "visible", opacity: "1" } as CSSStyleDeclaration);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return rect(this.dataset.visible === "true" ? 0 : 2000); });
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("progressive candidate collection", () => {
  it("finds a viewport headline beyond the first 700 DOM candidates and eventually returns the entire tail", () => {
    const elements = Array.from({ length: 750 }, (_, index) => paragraph(`Synthetic scene ${index}`, index === 749));
    const collector = new CandidateCollector();
    const first = collector.collectText(DEFAULT_SETTINGS, "scope", 36);
    expect(first[0]!.node.parentElement).toBe(elements[749]);
    const returned = new Set(first.map(({ node }) => node));
    let passes = 0;
    while (collector.hasPendingText && passes++ < 100) {
      for (const { node } of collector.collectText(DEFAULT_SETTINGS, "scope", 36)) returned.add(node);
    }
    expect(returned.size).toBe(750);
    expect(collector.hasPendingText).toBe(false);
    expect(collector.collectText(DEFAULT_SETTINGS, "scope")).toHaveLength(0);
  });

  it("reserves progress for older offscreen candidates while new viewport content keeps arriving", () => {
    const old = Array.from({ length: 10 }, (_, index) => paragraph(`Old offscreen scene ${index}`));
    Array.from({ length: 36 }, (_, index) => paragraph(`Visible scene ${index}`, true));
    const collector = new CandidateCollector(); const returned = new Set<Text>();
    for (let pass = 0; pass < 10; pass++) {
      const added = Array.from({ length: 4 }, (_, index) => paragraph(`New visible scene ${pass}-${index}`, true));
      collector.enqueueRoots(added);
      for (const { node } of collector.collectText(DEFAULT_SETTINGS, "scope", 4)) returned.add(node);
    }
    expect(old.every((element) => returned.has(element.firstChild as Text))).toBe(true);
  });

  it("admits a new viewport mutation before an advanced cursor on a large page", () => {
    Array.from({ length: 1200 }, (_, index) => paragraph(`Old offscreen scene ${index}`));
    const settings = { ...DEFAULT_SETTINGS, maxTextNodesPerScan: 200 };
    const collector = new CandidateCollector(); collector.collectText(settings, "scope", 36);
    const added = paragraph("New viewport headline", true); document.body.prepend(added);
    collector.enqueueRoots([added]);
    expect(collector.collectText(settings, "scope", 36)[0]!.node.parentElement).toBe(added);
  });

  it("falls back to a complete traversal when more than 64 mutation roots arrive after the page was finished", () => {
    paragraph("Original completed content");
    const collector = new CandidateCollector(); collector.collectText(DEFAULT_SETTINGS, "scope", 36);
    expect(collector.hasPendingText).toBe(false);
    const added = Array.from({ length: 65 }, (_, index) => paragraph(`New semantic scene ${index}`));
    collector.enqueueRoots(added);
    const returned = new Set<Text>(); let passes = 0;
    while (collector.hasPendingText && passes++ < 20) {
      for (const { node } of collector.collectText(DEFAULT_SETTINGS, "scope", 36)) returned.add(node);
    }
    expect(returned.size).toBe(65);
    expect(returned.has(added[64]!.firstChild as Text)).toBe(true);
    expect(collector.hasPendingText).toBe(false);
  });

  it("does not rewalk a completed document while draining its deferred candidates", () => {
    Array.from({ length: 700 }, (_, index) => paragraph(`Synthetic scene ${index}`));
    const collector = new CandidateCollector(); collector.collectText(DEFAULT_SETTINGS, "scope", 36);
    const readStyle = vi.mocked(getComputedStyle); readStyle.mockClear();
    collector.collectText(DEFAULT_SETTINGS, "scope", 36);
    // Existing deferred snapshots are checked once; no second full traversal is started.
    expect(readStyle.mock.calls.length).toBeLessThan(700);
  });

  it("rechecks viewport positions between bounded collections", () => {
    const old = paragraph("Old offscreen content"); const nowVisible = paragraph("Content after scrolling");
    const collector = new CandidateCollector();
    expect(collector.collectText(DEFAULT_SETTINGS, "scope", 1)[0]!.node.parentElement).toBe(old);
    nowVisible.dataset.visible = "true";
    expect(collector.collectText(DEFAULT_SETTINGS, "scope", 1)[0]!.node.parentElement).toBe(nowVisible);
  });

  it("continues large pages through bounded traversal chunks without losing detached queued siblings", () => {
    const elements = Array.from({ length: 900 }, (_, index) => paragraph(`Synthetic scene ${index}`));
    const settings = { ...DEFAULT_SETTINGS, maxTextNodesPerScan: 50 };
    const collector = new CandidateCollector(); const returned = new Set(collector.collectText(settings, "scope").map(({ text }) => text));
    elements[200]!.remove(); elements[201]!.remove();
    let passes = 0;
    while (collector.hasPendingText && passes++ < 100) {
      for (const { text } of collector.collectText(settings, "scope")) returned.add(text);
    }
    expect(returned.size).toBe(898);
    expect(returned.has("Synthetic scene 899")).toBe(true);
    expect(collector.hasPendingText).toBe(false);
  });

  it("retains image candidates beyond one scan and prioritizes an on-screen image", () => {
    const elements = Array.from({ length: 100 }, (_, index) => {
      const element = document.createElement("canvas"); element.title = `Synthetic frame ${index}`;
      element.dataset.visible = String(index === 99); document.body.append(element); return element;
    });
    const collector = new CandidateCollector(); const first = collector.collectImages(DEFAULT_SETTINGS, "scope");
    expect(first[0]!.element).toBe(elements[99]);
    expect(first).toHaveLength(80);
    expect(collector.hasPendingImages).toBe(true);
    const second = collector.collectImages(DEFAULT_SETTINGS, "scope");
    expect(new Set([...first, ...second].map(({ element }) => element)).size).toBe(100);
    expect(collector.hasPendingImages).toBe(false);
  });
});
