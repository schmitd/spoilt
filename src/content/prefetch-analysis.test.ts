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
  it.each([{ remove: [25] }, { remove: [24, 25, 26] }])("continues after hydration detaches siblings $remove between chunks", async ({ remove }) => {
    const text = "The captain quietly survives the battle";
    const applier = new PreparedTextApplier(new Redactor(), { ...DEFAULT_SETTINGS, scanImages: false, maxTextNodesPerScan: 50 }, {
      url: location.href, signature: "", createdAt: Date.now(),
      matches: [{ text, match: { ruleId: "local-ai", ruleName: "Story", reason: "semantic" } }],
    });
    applier.start();
    const section = document.createElement("section");
    section.innerHTML = Array.from({ length: 80 }, (_, i) => `<p id="cursor-${i}">Ordinary safe prose ${i}</p>`).join("") + `<h1>${text}</h1>`;
    document.body.append(section);
    await Promise.resolve();
    // The first 50 visits end at the 25th paragraph. Its next sibling is queued
    // while this paragraph's text and the remaining siblings are still pending.
    for (const index of remove) section.querySelector(`#cursor-${index}`)!.remove();
    expect(section.querySelector("h1 .spoilt-redacted-text")).toBeNull();
    try { await vi.waitFor(() => expect(section.querySelector("h1 .spoilt-redacted-text")).toBeTruthy(), { timeout: 500 }); }
    finally { applier.stop(); }
  });
  it.each(['<code>exampleterm</code>', '<span hidden>exampleterm</span>', '<span aria-hidden="true">exampleterm</span>'])("does not match excluded descendants: %s", (excluded) => {
    const settings = { ...DEFAULT_SETTINGS, rules: [{ id: "topic", name: "Topic", description: "", keywords: ["exampleterm"], enabled: true }] };
    document.body.innerHTML = `<p>Ordinary safe prose ${excluded}</p>`;
    const applier = new PreparedTextApplier(new Redactor(), settings, { url: location.href, signature: "", createdAt: Date.now(), matches: [] });
    applier.start();
    const count = document.querySelectorAll(".spoilt-redacted-text").length;
    applier.stop();
    expect(count).toBe(0);
  });
  it("does not synchronously rewalk unchanged subtrees for repeated root class/style changes", async () => {
    document.body.innerHTML = Array.from({ length: 1000 }, (_, i) => `<p>Ordinary safe prose ${i}</p>`).join("");
    const applier = new PreparedTextApplier(new Redactor(), { ...DEFAULT_SETTINGS, maxTextNodesPerScan: 50 }, { url: location.href, signature: "", createdAt: Date.now(), matches: [] });
    applier.start();
    await Promise.resolve();
    const walk = vi.spyOn(document, "createTreeWalker");
    for (let i = 0; i < 20; i++) {
      document.documentElement.className = `theme-${i}`;
      document.documentElement.style.setProperty("--theme", String(i));
    }
    await Promise.resolve();
    const visits = walk.mock.calls.length;
    applier.stop(); walk.mockRestore();
    document.documentElement.removeAttribute("class"); document.documentElement.removeAttribute("style");
    expect(visits).toBeLessThanOrEqual(1);
  });
  it.each(["failed", "no-store", "oversize"])("caps speculative image attempts for %s responses", async (kind) => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => kind === "failed" ? new Response(null, { status: 404 })
      : new Response("bytes", { headers: { "content-type": "image/png", ...(kind === "no-store" ? { "cache-control": "no-store" } : { "content-length": "2000000" }) } }));
    vi.stubGlobal("LanguageModel", { availability: async () => "available" });
    try {
      const html = Array.from({ length: 20 }, (_, i) => `<img src="/failed-${i}.png" alt="A scene">`).join("");
      await precomputePage("https://example.com/story", html, { ...DEFAULT_SETTINGS, prefetchLinks: true, scanText: false, useLocalAI: true, useVision: true, rules: [] }, normalizeMemory(), new AbortController().signal);
      expect(request).toHaveBeenCalledTimes(3);
    } finally { request.mockRestore(); vi.unstubAllGlobals(); }
  });
  it("coalesces a revealed subtree and completes bounded continuation work", async () => {
    const settings = { ...DEFAULT_SETTINGS, scanImages: false, maxTextNodesPerScan: 50,
      rules: [{ id: "topic", name: "Topic", description: "", keywords: ["exampleterm"], enabled: true }] };
    const applier = new PreparedTextApplier(new Redactor(), settings, { url: location.href, signature: "", createdAt: Date.now(), matches: [] });
    applier.start();
    const section = document.createElement("section"); section.hidden = true;
    section.innerHTML = Array.from({ length: 300 }, (_, i) => `<p>exampleterm content ${i}</p>`).join("");
    document.body.append(section);
    await Promise.resolve();
    section.hidden = false;
    section.setAttribute("aria-hidden", "false"); section.setAttribute("aria-hidden", "false");
    await Promise.resolve();
    const immediate = section.querySelectorAll(".spoilt-redacted-text").length;
    expect(immediate).toBeGreaterThan(0);
    expect(immediate).toBeLessThanOrEqual(50);
    try { await vi.waitFor(() => expect(section.querySelectorAll(".spoilt-redacted-text")).toHaveLength(300)); }
    finally { applier.stop(); }
  });
  it("keeps an inline group stable when its own mask wrappers exceed the node budget", async () => {
    const fragments = Array.from({ length: 30 }, (_, i) => `part${i} `);
    const text = fragments.join("").trim();
    document.body.innerHTML = `<h1>${fragments.map(part => `<b>${part}</b>`).join("")}</h1>`;
    const applier = new PreparedTextApplier(new Redactor(), DEFAULT_SETTINGS, { url: location.href, signature: "", createdAt: Date.now(),
      matches: [{ text, match: { ruleId: "local-ai", ruleName: "Story", reason: "semantic" } }] });
    applier.start();
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelectorAll("h1 .spoilt-redacted-text")).toHaveLength(30);
    applier.stop();
  });
  it("applies new small changes ahead of an existing large deferred scan", async () => {
    document.body.innerHTML = Array.from({ length: 1000 }, (_, i) => `<p>Ordinary safe text ${i}</p>`).join("");
    const settings = { ...DEFAULT_SETTINGS, scanImages: false, maxTextNodesPerScan: 50,
      rules: [{ id: "topic", name: "Topic", description: "", keywords: ["exampleterm"], enabled: true }] };
    const applier = new PreparedTextApplier(new Redactor(), settings, { url: location.href, signature: "", createdAt: Date.now(), matches: [] });
    applier.start();
    document.body.insertAdjacentHTML("beforeend", "<h1>exampleterm new headline</h1>");
    await Promise.resolve();
    expect(document.querySelector("h1 .spoilt-redacted-text")).toBeTruthy();
    applier.stop();
  });
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
  it("reapplies exact full text after hydration splits it across inline nodes", async () => {
    const text = "The captain quietly survives the battle";
    const applier = new PreparedTextApplier(new Redactor(), DEFAULT_SETTINGS, {
      url: location.href, signature: "", createdAt: Date.now(),
      matches: [{ text, match: { ruleId: "local-ai", ruleName: "Story", reason: "semantic" } }],
    });
    document.body.innerHTML = `<h1>${text}</h1>`;
    applier.start();
    document.querySelector("h1")!.innerHTML = "<strong>The captain</strong> quietly survives <em>the battle</em>";
    await Promise.resolve();
    expect(document.querySelectorAll("h1 .spoilt-redacted-text")).toHaveLength(3);
    document.querySelector("h1")!.textContent = `${text}, allegedly`;
    await Promise.resolve();
    expect(document.querySelector("h1 .spoilt-redacted-text")).toBeNull();
    applier.stop();
  });
  it("retains live decisions for replacement nodes but restores changed safe text", async () => {
    const text = "The captain quietly survives the battle";
    const applier = new PreparedTextApplier(new Redactor(), DEFAULT_SETTINGS, {
      url: location.href, signature: "", createdAt: Date.now(), matches: [],
    });
    applier.start();
    applier.rememberText(text, { ruleId: "local-ai", ruleName: "Story", reason: "semantic" });
    document.body.innerHTML = `<h1>${text}</h1>`;
    await Promise.resolve();
    const mask = document.querySelector("h1 .spoilt-redacted-text")!;
    expect(mask).toBeTruthy();
    mask.firstChild!.textContent = "Ordinary safe headline";
    await Promise.resolve();
    expect(document.querySelector("h1 .spoilt-redacted-text")).toBeNull();
    expect(applier.snapshot("rules").matches).toHaveLength(1);
    applier.stop();
  });
  it("handles partial hydration and clears a split decision when the complete text changes", async () => {
    const text = "The captain quietly survives the battle";
    const applier = new PreparedTextApplier(new Redactor(), DEFAULT_SETTINGS, {
      url: location.href, signature: "", createdAt: Date.now(),
      matches: [{ text, match: { ruleId: "local-ai", ruleName: "Story", reason: "semantic" } }],
    });
    document.body.innerHTML = "<div id='headline'><strong>The captain</strong> quietly survives <em>the battle</em></div>";
    applier.start();
    document.querySelector("strong")!.textContent = "The captain";
    await Promise.resolve();
    expect(document.querySelectorAll("#headline .spoilt-redacted-text")).toHaveLength(3);
    document.querySelector("em")!.textContent = "a picnic";
    await Promise.resolve();
    expect(document.querySelector("#headline .spoilt-redacted-text")).toBeNull();
    applier.stop();
  });
  it("applies direct rules before layout and leaves editable descendants alone", async () => {
    const settings = { ...DEFAULT_SETTINGS, useLocalAI: false, rules: [{ id: "x", name: "Topic", description: "", keywords: ["exampleterm"], enabled: true }] };
    const applier = new PreparedTextApplier(new Redactor(), settings, {
      url: location.href, signature: "", createdAt: Date.now(), matches: [],
    });
    applier.start();
    document.body.innerHTML = '<h1>exampleterm headline</h1><div contenteditable="true"><b>exampleterm editor</b></div>';
    await Promise.resolve();
    expect(document.querySelector("h1 .spoilt-redacted-text")).toBeTruthy();
    expect(document.querySelector("[contenteditable] .spoilt-redacted-text")).toBeNull();
    applier.stop();
  });
  it("rejects stale text snapshots at the point of redaction", () => {
    const heading = document.createElement("h1");
    const node = document.createTextNode("An old spoiler snapshot");
    heading.append(node); document.body.append(heading);
    node.data = "Safe updated headline";
    new Redactor().text({ node, text: "An old spoiler snapshot" }, { ruleId: "x", ruleName: "Story", reason: "semantic" }, "whiteout", true);
    expect(heading.querySelector(".spoilt-redacted-text")).toBeNull();
  });
  it("never applies disabled text or image categories from a prepared result", () => {
    const applier = new PreparedTextApplier(new Redactor(), { ...DEFAULT_SETTINGS, scanText: false, scanImages: false }, {
      url: location.href, signature: "", createdAt: Date.now(),
      matches: [{ text: "Known spoiler headline", match: { ruleId: "x", ruleName: "Story", reason: "semantic" } }],
      images: [{ url: "https://example.com/a.png", alt: "A scene", match: { ruleId: "x", ruleName: "Story", reason: "semantic" } }],
    });
    document.body.innerHTML = '<h1>Known spoiler headline</h1><img src="https://example.com/a.png" alt="A scene">';
    applier.start();
    expect(document.querySelector(".spoilt-redacted-text,.spoilt-image-shell")).toBeNull();
    applier.stop();
  });
  it("does not carry exact semantic decisions across a query-only route change", async () => {
    const originalUrl = location.href;
    const applier = new PreparedTextApplier(new Redactor(), DEFAULT_SETTINGS, {
      url: originalUrl, signature: "", createdAt: Date.now(),
      matches: [{ text: "Known spoiler headline", match: { ruleId: "x", ruleName: "Story", reason: "semantic" } }],
    });
    applier.start();
    history.pushState({}, "", "?different-route");
    document.body.innerHTML = "<h1>Known spoiler headline</h1>";
    await Promise.resolve();
    expect(document.querySelector(".spoilt-redacted-text")).toBeNull();
    applier.stop();
    history.replaceState({}, "", originalUrl);
  });
});
