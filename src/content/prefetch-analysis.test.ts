import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeMemory } from "../core/memory";
import { DEFAULT_SETTINGS } from "../core/settings";
import { Redactor } from "./dom";
import { browser } from "wxt/browser";
import { analysisSignature, collectPrefetchedText, precomputePage, PreparedTextApplier } from "./prefetch-analysis";

vi.mock("wxt/browser", () => ({ browser: { runtime: { sendMessage: vi.fn() } } }));
vi.mock("../platform/storage", () => ({ updateStatus: vi.fn() }));

afterEach(() => { document.body.innerHTML = ""; });

describe("prepared page analysis", () => {
  it("extracts bounded inert text while excluding scripts and editable fields", () => {
    const nodes = collectPrefetchedText('<h1>The secret outcome is revealed</h1><script>window.alert(1)</script><textarea>private input</textarea><p>Safe article text</p>', 1);
    expect(nodes.map((item) => item.text)).toEqual(["The secret outcome is revealed"]);
  });
  it("prioritizes article text over a large navigation menu", () => {
    const menus = Array.from({ length: 100 }, (_, i) => `<a>Menu entry ${i}</a>`).join("");
    const nodes = collectPrefetchedText(`<nav>${menus}</nav><article><h1>Article headline</h1><p>Article detail</p></article>`, 2);
    expect(nodes.map((item) => item.text)).toEqual(["Article headline", "Article detail"]);
  });
  it("prepares direct matches without waiting for or requiring AI", async () => {
    const send = vi.mocked(browser.runtime.sendMessage);
    send.mockReset();
    send.mockResolvedValue(undefined);
    const settings = { ...DEFAULT_SETTINGS, prefetchLinks: true, useLocalAI: false, scanImages: false,
      rules: [{ id: "blocked", name: "Restricted topic", description: "", keywords: ["exampleterm"], enabled: true }] };
    await precomputePage("https://example.com/story", "<article><h1>exampleterm appears here</h1></article>", settings, normalizeMemory(), new AbortController().signal);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({ type: "savePrefetchAnalysis", analysis: { matches: [{ text: "exampleterm appears here", ai: false }] } });
  });
  it("prepares CDN and responsive image metadata without downloading pixels", async () => {
    const send = vi.mocked(browser.runtime.sendMessage);
    send.mockReset(); send.mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const settings = { ...DEFAULT_SETTINGS, prefetchLinks: true, useLocalAI: false, scanText: false,
      rules: [{ id: "topic", name: "Topic", description: "", keywords: ["exampleterm"], enabled: true }] };
    await precomputePage("https://example.com/story", '<picture><source srcset="https://cdn.example.net/photo-wide.jpg?w=1200 1200w"><img src="https://cdn.example.net/photo.jpg?w=640" alt="exampleterm photo"></picture>', settings, normalizeMemory(), new AbortController().signal);
    expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore();
    expect(send.mock.calls[0]?.[0]).toMatchObject({ analysis: { images: [
      { url: "https://cdn.example.net/photo.jpg?w=640", alt: "exampleterm photo", ai: false },
      { url: "https://cdn.example.net/photo-wide.jpg?w=1200", alt: "exampleterm photo", ai: false },
    ] } });
  });
  it("masks a responsive picture from a prepared CDN metadata decision", async () => {
    const redactor = new Redactor();
    const applier = new PreparedTextApplier(redactor, DEFAULT_SETTINGS, {
      url: "https://example.com/story", signature: "", createdAt: Date.now(), matches: [],
      images: [{ url: "https://cdn.example.net/photo-wide.jpg?w=1200", alt: "A scene", ai: false,
        match: { ruleId: "topic", ruleName: "Topic", reason: "keyword" } }],
    });
    applier.start();
    document.body.insertAdjacentHTML("beforeend", '<picture><source srcset="https://cdn.example.net/photo-wide.jpg?w=1200 1200w"><img src="https://cdn.example.net/photo.jpg" alt="A scene"></picture>');
    await Promise.resolve();
    expect(document.querySelector(".spoilt-image-shell > picture > img")).toBeTruthy();
    expect(redactor.counters.aiImages).toBe(0);
    applier.stop();
  });
  it("invalidates cached decisions when boundaries or memory change", () => {
    const memory = normalizeMemory();
    const signature = analysisSignature(DEFAULT_SETTINGS, memory);
    expect(analysisSignature({ ...DEFAULT_SETTINGS, strictness: "strict" }, memory)).not.toBe(signature);
    expect(analysisSignature(DEFAULT_SETTINGS, { ...memory, lastUpdatedAt: "new" })).not.toBe(signature);
  });
  it("masks a prepared image only when its source and description still match", async () => {
    const redactor = new Redactor();
    const applier = new PreparedTextApplier(redactor, DEFAULT_SETTINGS, {
      url: "https://example.com/story", signature: "", createdAt: Date.now(), matches: [],
      images: [{ url: "https://example.com/story.png", alt: "A scene", match: { ruleId: "local-ai-image", ruleName: "Story", reason: "image match" } }],
    });
    applier.start();
    document.body.insertAdjacentHTML("beforeend", '<img src="https://example.com/story.png" alt="A scene"><img src="https://example.com/story.png" alt="A different scene">');
    await Promise.resolve();
    expect(document.querySelectorAll(".spoilt-image-shell")).toHaveLength(1);
    expect(document.querySelector(".spoilt-image-shell img")?.getAttribute("alt")).toBe("A scene");
    applier.stop();
  });
  it("masks exact cached text as it arrives without hiding changed text", async () => {
    const redactor = new Redactor();
    const applier = new PreparedTextApplier(redactor, DEFAULT_SETTINGS, {
      url: "https://example.com/story", signature: "", createdAt: Date.now(),
      matches: [{ text: "The secret outcome is revealed", match: { ruleId: "local-ai", ruleName: "Story", reason: "semantic match" } }],
    });
    applier.start();
    const article = document.createElement("article");
    article.innerHTML = '<h1>The secret outcome is revealed</h1><p>The secret outcome has changed</p>';
    document.body.append(article);
    await Promise.resolve();
    expect(article.querySelector("h1 .spoilt-redacted-text")?.textContent).toBe("The secret outcome is revealed");
    expect(article.querySelector("p .spoilt-redacted-text")).toBeNull();
    applier.stop();
    article.insertAdjacentHTML("beforeend", "<p>The secret outcome is revealed</p>");
    await Promise.resolve();
    expect(article.querySelectorAll(".spoilt-redacted-text")).toHaveLength(1);
  });
});
