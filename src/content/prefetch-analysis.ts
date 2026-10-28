import { browser } from "wxt/browser";
import { descriptionMatch, keywordMatch, normalizeWhitespace } from "../core/matching";
import { memoryMatch } from "../core/memory";
import type { Match, Settings, SpoilerMemory } from "../core/types";
import { AiClassifier } from "./ai-classifier";
import { imageMetadata, imageSourceUrls, Redactor, type TextCandidate } from "./dom";

export interface CachedAnalysis {
  url: string;
  signature: string;
  createdAt: number;
  matches: Array<{ text: string; match: Match; ai?: boolean }>;
  images?: Array<{ url: string; alt: string; match: Match; ai?: boolean }>;
}

export function analysisSignature(settings: Settings, memory: SpoilerMemory): string {
  return JSON.stringify({ rules: settings.rules, strictness: settings.strictness,
    memory: memory, enabled: settings.enabled, text: settings.scanText, images: settings.scanImages,
    ai: settings.useLocalAI, vision: settings.useVision });
}

// A template is inert: no scripts execute and its resource elements do not load.
export function collectPrefetchedText(html: string, limit: number): TextCandidate[] {
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const preferred: TextCandidate[] = [];
  const other: TextCandidate[] = [];
  // Bound traversal independently of the number returned, while giving article
  // content priority over navigation and recommendation menus.
  let visited = 0;
  for (let node = walker.nextNode(); node && visited < 20_000; node = walker.nextNode()) {
    visited += 1;
    const textNode = node as Text;
    const text = normalizeWhitespace(textNode.data);
    const parent = textNode.parentElement;
    if (!parent || text.length < 4 || text.length > 600
      || parent.closest('head,script,style,noscript,template,textarea,input,select,option,code,pre,kbd,samp,[hidden],[aria-hidden="true"],[contenteditable]')) continue;
    const target = parent.closest('article,main,[role="main"]') ? preferred : other;
    if (target.length < limit) target.push({ node: textNode, text });
  }
  return [...preferred, ...other].slice(0, limit);
}

export async function precomputePage(url: string, html: string, settings: Settings, memory: SpoilerMemory, signal: AbortSignal): Promise<void> {
  if (!settings.enabled || !settings.prefetchLinks || signal.aborted) return;
  const matches: CachedAnalysis["matches"] = [];
  const images: NonNullable<CachedAnalysis["images"]> = [];
  if (settings.scanImages) {
    const template = document.createElement("template");
    template.innerHTML = html;
    const imageElements = [...template.content.querySelectorAll<HTMLImageElement>("img")].slice(0, settings.maxImagesPerScan);
    for (const image of imageElements) {
      const metadata = imageMetadata(image, url);
      const match = keywordMatch(metadata, settings.rules)
        || memoryMatch(metadata, settings.rules, memory)
        || descriptionMatch(metadata, settings.rules);
      if (!match) continue;
      for (const source of imageSourceUrls(image, url)) {
        if (images.length < 300) images.push({ url: source, alt: image.alt, match, ai: false });
      }
    }
  }
  const signature = analysisSignature(settings, memory);
  const classifier = new AiClassifier();
  const save = async () => {
    if (signal.aborted || (!matches.length && !images.length)) return;
    await browser.runtime.sendMessage({ scope: "spoilt", type: "savePrefetchAnalysis", analysis: {
      url, signature, createdAt: Date.now(), matches: [...matches], images: [...images],
    } satisfies CachedAnalysis }).catch(() => undefined);
  };
  const aiCandidates: TextCandidate[] = [];
  if (settings.scanText) {
    const candidates = collectPrefetchedText(html, Math.min(settings.maxTextNodesPerScan, 700));
    for (const candidate of candidates) {
      const match = keywordMatch(candidate.text, settings.rules)
        || memoryMatch(candidate.text, settings.rules, memory)
        || descriptionMatch(candidate.text, settings.rules);
      if (match) matches.push({ text: candidate.text, match, ai: false });
      else if (aiCandidates.length < 72) aiCandidates.push(candidate);
    }
  }
  await save();
  if (settings.useLocalAI && aiCandidates.length && !signal.aborted) {
    await classifier.text(aiCandidates, settings, memory, (candidate, match) => {
      matches.push({ text: candidate.text, match, ai: true });
    }, () => !signal.aborted, save);
    await save();
  }
  if (!signal.aborted && settings.useLocalAI && settings.scanImages && settings.useVision && typeof LanguageModel !== "undefined") {
    // Only fetch a small number of ordinary same-origin images, and only if the
    // on-device vision model is already available. Never retain image bytes.
    try {
      const available = await LanguageModel.availability({
        expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
        initialPrompts: [{ role: "system", content: "Classify only against the user's boundaries. Prefer false when uncertain." }],
      });
      if (available === "available" && !signal.aborted) {
        const inputs = (await collectPrefetchedImages(html, url, signal)).filter(({ candidate }) => !images.some((item) => item.url === (candidate.element as HTMLImageElement).src));
        await classifier.prefetchedImages(inputs, settings, memory, (candidate, match) => {
          const element = candidate.element as HTMLImageElement;
          images.push({ url: element.src, alt: element.alt, match, ai: true });
        }, () => !signal.aborted);
      }
    } catch { /* Vision precomputation is optional; normal page scanning remains active. */ }
  }
  if (images.length) await save();
}

async function collectPrefetchedImages(html: string, pageUrl: string, signal: AbortSignal): Promise<Array<{ candidate: { element: Element; metadataText: string }; blob: Blob }>> {
  const template = document.createElement("template");
  template.innerHTML = html;
  const inputs: Array<{ candidate: { element: Element; metadataText: string }; blob: Blob }> = [];
  const seen = new Set<string>();
  for (const image of template.content.querySelectorAll<HTMLImageElement>("img[src]")) {
    if (inputs.length >= 3 || signal.aborted) break;
    if (image.hasAttribute("srcset") || image.closest('picture,[hidden],[aria-hidden="true"]')) continue;
    let source: URL;
    try { source = new URL(image.getAttribute("src") || "", pageUrl); } catch { continue; }
    if (source.origin !== new URL(pageUrl).origin || source.search || !/^https?:$/.test(source.protocol) || seen.has(source.href)) continue;
    seen.add(source.href);
    try {
      const response = await fetch(source.href, { mode: "same-origin", credentials: "same-origin", redirect: "error", priority: "low",
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
      if (!response.ok || !/^image\//i.test(response.headers.get("content-type") || "")
        || /\bno-store\b/i.test(response.headers.get("cache-control") || "")
        || Number(response.headers.get("content-length")) > 1_000_000 || !response.body) {
        await response.body?.cancel(); continue;
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 1_000_000) { await reader.cancel(); break; }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      if (bytes > 1_000_000 || signal.aborted) continue;
      image.src = source.href;
      const blob = new Blob(chunks as BlobPart[], { type: response.headers.get("content-type") || "image/png" });
      const metadataText = normalizeWhitespace([image.alt, image.title, image.getAttribute("aria-label"), source.href].filter(Boolean).join(" ")).slice(0, 1000);
      inputs.push({ candidate: { element: image, metadataText }, blob });
    } catch { /* Ignore failed image speculation. */ }
  }
  return inputs;
}

export class PreparedTextApplier {
  #observer: MutationObserver | null = null;
  #matches = new Map<string, { match: Match; ai: boolean }>();
  #redactor: Redactor;
  #images = new Map<string, { alt: string; match: Match; ai: boolean }>();
  #settings: Settings;

  constructor(redactor: Redactor, settings: Settings, analysis: CachedAnalysis) {
    this.#redactor = redactor;
    this.#settings = settings;
    for (const item of analysis.matches) this.#matches.set(item.text, { match: item.match, ai: item.ai !== false });
    for (const item of analysis.images ?? []) this.#images.set(item.url, { alt: item.alt, match: item.match, ai: item.ai !== false });
  }

  start(): void {
    if ((!this.#matches.size && !this.#images.size) || !document.documentElement) return;
    this.#observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData" || record.type === "attributes") this.#apply(record.target);
        else for (const node of record.addedNodes) this.#apply(node);
      }
    });
    this.#observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["src", "srcset", "data-src", "data-srcset", "alt"] });
    this.#apply(document.documentElement);
  }

  stop(): void { this.#observer?.disconnect(); this.#observer = null; }

  #apply(root: Node): void {
    if (root.nodeType === Node.TEXT_NODE) { this.#text(root as Text); return; }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root instanceof HTMLImageElement) this.#image(root);
    if (root instanceof Element) {
      root.querySelectorAll<HTMLImageElement>("img").forEach((image) => this.#image(image));
      if (root instanceof HTMLSourceElement) root.closest("picture")?.querySelectorAll<HTMLImageElement>("img").forEach((image) => this.#image(image));
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    for (const node of nodes) this.#text(node);
  }

  #image(element: HTMLImageElement): void {
    if (element.closest(".spoilt-image-shell")) return;
    for (const source of imageSourceUrls(element, location.href)) {
      const result = this.#images.get(source);
      if (result && result.alt === element.alt) {
        const target = element.closest("picture") ?? element;
        this.#redactor.image({ element: target, metadataText: "" }, result.match, this.#settings.redactionStyle, result.ai);
        return;
      }
    }
  }

  #text(node: Text): void {
    const parent = node.parentElement;
    if (!parent || parent.closest('script,style,noscript,template,textarea,input,select,option,code,pre,kbd,samp,[contenteditable],.spoilt-redacted-text')) return;
    const text = normalizeWhitespace(node.data);
    const result = this.#matches.get(text);
    if (result) this.#redactor.text({ node, text }, result.match, this.#settings.redactionStyle, result.ai);
  }
}
