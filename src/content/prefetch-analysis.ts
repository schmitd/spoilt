import { browser } from "wxt/browser";
import { descriptionMatch, keywordMatch, normalizeWhitespace } from "../core/matching";
import { matchingMemorySignature, memoryMatch } from "../core/memory";
import { criteriaSettings, relabelMatch } from "../core/rule-criteria";
import type { Match, Settings, SpoilerMemory } from "../core/types";
import { AiClassifier } from "./ai-classifier";
import { imageMetadata, imageSourceUrls, isSpoiltNode, MASKED_TEXT_CLASS, Redactor, shouldSkipElement, type TextCandidate } from "./dom";

export interface CachedAnalysis {
  url: string;
  signature: string;
  createdAt: number;
  matches: Array<{ text: string; match: Match; ai?: boolean }>;
  images?: Array<{ url: string; alt: string; match: Match; ai?: boolean }>;
  kind?: "live";
}

const INLINE_CONTAINERS = "h1,h2,h3,h4,h5,h6,p,li,a,figcaption,div,span";
const EXCLUDED_INLINE_CONTENT = 'h1,h2,h3,h4,h5,h6,p,li,div,section,article,main,table,form,input,textarea,select,[contenteditable],script,style,noscript,template,code,pre,kbd,samp,[hidden],[aria-hidden="true"]';
const MAX_INLINE_NODES = 64;
interface ApplyJob { root: Node; nodes: Generator<Node> }

export function analysisSignature(settings: Settings, memory: SpoilerMemory): string {
  return JSON.stringify({ criteriaVersion: 2, rules: criteriaSettings(settings).rules, strictness: settings.strictness,
    memory: matchingMemorySignature(memory, settings.rules), enabled: settings.enabled, text: settings.scanText, images: settings.scanImages,
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
  const classifier = new AiClassifier("speculative");
  const cancel = () => { void classifier.reset(); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
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
  if (!signal.aborted && settings.useLocalAI && settings.scanImages && settings.useVision) {
    // Only fetch a small number of ordinary same-origin images, and only if the
    // on-device vision model is already available. Never retain image bytes.
    try {
      if (await classifier.visionAvailable() && !signal.aborted) {
        const inputs = (await collectPrefetchedImages(html, url, signal)).filter(({ candidate }) => !images.some((item) => item.url === (candidate.element as HTMLImageElement).src));
        await classifier.prefetchedImages(inputs, settings, memory, (candidate, match) => {
          const element = candidate.element as HTMLImageElement;
          images.push({ url: element.src, alt: element.alt, match, ai: true });
        }, () => !signal.aborted);
      }
    } catch { /* Vision precomputation is optional; normal page scanning remains active. */ }
  }
  if (images.length) await save();
  } finally {
    signal.removeEventListener("abort", cancel);
    await classifier.reset();
  }
}

async function collectPrefetchedImages(html: string, pageUrl: string, signal: AbortSignal): Promise<Array<{ candidate: { element: Element; metadataText: string }; blob: Blob }>> {
  const template = document.createElement("template");
  template.innerHTML = html;
  const inputs: Array<{ candidate: { element: Element; metadataText: string }; blob: Blob }> = [];
  const seen = new Set<string>();
  let attempts = 0;
  // Bound the complete download phase as well as the number of attempts.
  const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  for (const image of template.content.querySelectorAll<HTMLImageElement>("img[src]")) {
    if (attempts >= 3 || downloadSignal.aborted) break;
    if (image.hasAttribute("srcset") || image.closest('picture,[hidden],[aria-hidden="true"]')) continue;
    let source: URL;
    try { source = new URL(image.getAttribute("src") || "", pageUrl); } catch { continue; }
    if (source.origin !== new URL(pageUrl).origin || source.search || !/^https?:$/.test(source.protocol) || seen.has(source.href)) continue;
    seen.add(source.href);
    attempts += 1;
    try {
      const response = await fetch(source.href, { mode: "same-origin", credentials: "same-origin", redirect: "error", priority: "low",
        signal: downloadSignal });
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
  #images = new Map<string, { alt: string; match: Match; ai: boolean }>();
  #inlineValues = new WeakMap<Element, string>();
  #checkedText = new WeakMap<Text, string>();
  #negativeInline = new WeakMap<Element, string>();
  #jobs: ApplyJob[] = [];
  #queued = new Map<Node, ApplyJob>();
  #timer = 0;
  #reapplyQueued = false;
  #url = location.href;

  constructor(
    private redactor: Redactor,
    private settings: Settings,
    analysis: CachedAnalysis,
    private memory: SpoilerMemory = { version: 1, enabled: false, lastUpdatedAt: "", lastError: "", entries: [], imageExamples: [], ruleRuns: {} },
  ) {
    for (const item of analysis.matches.slice(0, 700)) this.#matches.set(normalizeWhitespace(item.text), { match: relabelMatch(item.match, settings.rules), ai: item.ai !== false });
    for (const item of (analysis.images ?? []).slice(0, 300)) this.#images.set(item.url, { alt: item.alt, match: relabelMatch(item.match, settings.rules), ai: item.ai !== false });
  }

  refreshLabels(settings: Settings, memory = this.memory): void {
    this.settings = settings;
    this.memory = memory;
    for (const value of this.#matches.values()) value.match = relabelMatch(value.match, settings.rules);
    for (const value of this.#images.values()) value.match = relabelMatch(value.match, settings.rules);
  }

  start(): void {
    if (this.#observer || !this.settings.enabled || (!this.settings.scanText && !this.settings.scanImages)) return;
    this.#observer = new MutationObserver((records) => {
      if (location.href !== this.#url) return;
      const roots = new Set<Node>();
      const restored = new Set<Element>();
      const childTargets = new Set<Node>();
      for (const record of records) {
        // Presentation changes do not change text identities. The controller
        // schedules visibility-dependent AI separately; never rewalk a whole
        // page synchronously for a theme/animation update.
        if (record.type === "attributes" && (record.attributeName === "class" || record.attributeName === "style")) {
          const element = record.target as Element;
          if (!isSpoiltNode(element) && element.childElementCount === 0) roots.add(element);
          continue;
        }
        let parent = record.target instanceof Element ? record.target : record.target.parentElement;
        let groupRestored = false;
        while (parent) {
          const original = this.#inlineValues.get(parent);
          if (original && !restored.has(parent) && this.#inlineSnapshot(parent)?.text !== original) {
            this.#inlineValues.delete(parent);
            this.redactor.restoreTextWithin(parent);
            restored.add(parent); roots.add(parent); groupRestored = true;
            break;
          }
          parent = parent.parentElement;
        }
        if (groupRestored) continue;
        const current = this.redactor.restoreChanged(record.target);
        if (current !== record.target) { roots.add(current); continue; }
        if (isSpoiltNode(record.target)) continue;
        if (record.type === "characterData" || record.type === "attributes") roots.add(record.target);
        else {
          const added = [...record.addedNodes].filter(node => !isSpoiltNode(node));
          if (!added.length) continue;
          if (childTargets.has(record.target) || added.length > 1) roots.add(record.target);
          else { childTargets.add(record.target); roots.add(added[0]!); }
        }
      }
      if (this.#enqueue(roots)) this.#drain();
    });
    this.#observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["src", "srcset", "data-src", "data-srcset", "alt", "title", "poster", "hidden", "aria-hidden", "contenteditable", "class", "style"] });
    this.apply();
  }

  stop(): void {
    this.#observer?.disconnect(); this.#observer = null;
    window.clearTimeout(this.#timer); this.#timer = 0; this.#clearJobs();
  }

  apply(): void {
    if (!this.#observer || location.href !== this.#url || !document.documentElement) return;
    this.#enqueue(new Set([document.documentElement]));
    this.#drain();
  }

  rememberText(text: string, match: Match, ai = true): void {
    const key = normalizeWhitespace(text);
    if (location.href !== this.#url || !key || key.length > 4000) return;
    if (!this.#matches.has(key) && this.#matches.size >= 700) this.#matches.delete(this.#matches.keys().next().value!);
    this.#matches.set(key, { match: relabelMatch(match, this.settings.rules), ai });
    this.#checkedText = new WeakMap(); this.#negativeInline = new WeakMap();
    this.#reapply();
  }

  rememberImage(element: Element, match: Match, ai = true): void {
    const image = element instanceof HTMLImageElement ? element : element.querySelector("img");
    if (!image || location.href !== this.#url) return;
    for (const url of imageSourceUrls(image, location.href)) {
      if (!this.#images.has(url) && this.#images.size >= 300) this.#images.delete(this.#images.keys().next().value!);
      this.#images.set(url, { alt: image.alt, match: relabelMatch(match, this.settings.rules), ai });
    }
    this.#reapply();
  }

  snapshot(signature: string): CachedAnalysis {
    return { url: this.#url, signature, createdAt: Date.now(), kind: "live",
      matches: [...this.#matches].map(([text, result]) => ({ text, ...result })),
      images: [...this.#images].map(([url, result]) => ({ url, ...result })) };
  }

  #reapply(): void {
    if (this.#reapplyQueued) return;
    this.#reapplyQueued = true;
    queueMicrotask(() => { this.#reapplyQueued = false; this.apply(); });
  }

  #enqueue(roots: Set<Node>): boolean {
    const fresh = new Set<ApplyJob>();
    for (const root of roots) {
      if (!root.isConnected || isSpoiltNode(root)) continue;
      let parent = root.parentNode;
      while (parent && !roots.has(parent)) parent = parent.parentNode;
      if (parent) continue;
      const existing = this.#queued.get(root);
      if (existing) { existing.nodes.return(undefined); existing.nodes = this.#nodes(root); fresh.add(existing); }
      else {
        const job = { root, nodes: this.#nodes(root) };
        this.#queued.set(root, job); fresh.add(job);
      }
    }
    // New small changes must not wait behind the deferred tail of a large page.
    if (fresh.size) this.#jobs = [...fresh, ...this.#jobs.filter(job => !fresh.has(job))];
    return fresh.size > 0;
  }

  *#nodes(root: Node): Generator<Node> {
    const stack: Array<{ parent: Node; cursor: Range }> = [];
    let next: Node | null = root;
    try {
      while (next || stack.length) {
        if (next) {
          const node: Node = next; next = null;
          if (!node.isConnected || (node instanceof Element && shouldSkipElement(node))) continue;
          yield node;
          // A live boundary survives removal of either the visited child or
          // the next sibling while a continuation is paused. Never depend on
          // nextSibling from a possibly detached queued node.
          if (node.isConnected && node.firstChild && !isSpoiltNode(node)) {
            const cursor = document.createRange();
            cursor.setStart(node, 0); cursor.collapse(true);
            stack.push({ parent: node, cursor });
          }
        } else {
          const frame = stack[stack.length - 1]!;
          if (!frame.parent.isConnected || frame.cursor.startContainer !== frame.parent) {
            frame.cursor.detach(); stack.pop(); continue;
          }
          const offset = frame.cursor.startOffset;
          next = frame.parent.childNodes.item(offset);
          if (!next) { frame.cursor.detach(); stack.pop(); continue; }
          frame.cursor.setStart(frame.parent, offset + 1); frame.cursor.collapse(true);
        }
      }
    } finally {
      for (const frame of stack) frame.cursor.detach();
    }
  }

  #clearJobs(): void {
    for (const job of this.#jobs) job.nodes.return(undefined);
    this.#jobs = []; this.#queued.clear();
  }

  #drain(): void {
    window.clearTimeout(this.#timer); this.#timer = 0;
    if (!this.#observer || location.href !== this.#url) { this.#clearJobs(); return; }
    let remaining = Math.max(1, (this.settings.scanText ? this.settings.maxTextNodesPerScan : 0)
      + (this.settings.scanImages ? this.settings.maxImagesPerScan : 0));
    let completed = 0;
    while (remaining-- > 0 && completed < this.#jobs.length) {
      const job = this.#jobs[completed]!;
      const step = job.nodes.next();
      if (step.done) { this.#queued.delete(job.root); completed += 1; continue; }
      const node = step.value;
      if (node.nodeType === Node.TEXT_NODE) {
        if (!this.#inlineAround(node.parentElement)) this.#text(node as Text);
      } else if (node instanceof Element) {
        if (this.settings.scanText && node.matches(INLINE_CONTAINERS)) this.#inline(node);
        if (node instanceof HTMLImageElement) this.#image(node);
        if (node instanceof HTMLSourceElement) {
          const image = node.closest("picture")?.querySelector("img");
          if (image) this.#image(image);
        }
      }
    }
    if (completed) this.#jobs = this.#jobs.slice(completed);
    if (this.#jobs.length) this.#timer = window.setTimeout(() => this.#drain(), 0);
  }

  #match(text: string) {
    const cached = this.#matches.get(text);
    if (cached) return cached;
    const match = keywordMatch(text, this.settings.rules)
      || memoryMatch(text, this.settings.rules, this.memory)
      || descriptionMatch(text, this.settings.rules);
    return match ? { match, ai: false } : undefined;
  }

  #image(element: HTMLImageElement): void {
    if (!this.settings.scanImages || shouldSkipElement(element)) return;
    const direct = this.#match(imageMetadata(element));
    if (direct && !direct.ai) {
      this.redactor.image({ element: element.closest("picture") ?? element, metadataText: imageMetadata(element) }, direct.match, this.settings.redactionStyle);
      return;
    }
    for (const source of imageSourceUrls(element, location.href)) {
      const result = this.#images.get(source);
      if (result && result.alt === element.alt) {
        this.redactor.image({ element: element.closest("picture") ?? element, metadataText: "" }, result.match, this.settings.redactionStyle, result.ai);
        return;
      }
    }
  }

  #text(node: Text): void {
    if (!this.settings.scanText || !node.parentElement || shouldSkipElement(node.parentElement)) return;
    const text = normalizeWhitespace(node.data);
    if (text.length < 4 || this.#checkedText.get(node) === text) return;
    this.#checkedText.set(node, text);
    const result = this.#match(text);
    if (result) this.redactor.text({ node, text }, result.match, this.settings.redactionStyle, result.ai);
  }

  #inlineSnapshot(element: Element): { text: string; nodes: Text[] } | null {
    if (shouldSkipElement(element)) return null;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let visited = 0;
    let characters = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // Our wrappers must not make the same inline group exceed its original
      // structural budget and repeatedly restore/reapply itself.
      if (!(node instanceof Element && node.classList.contains(MASKED_TEXT_CLASS)) && ++visited > MAX_INLINE_NODES) return null;
      if (node instanceof Element && node.matches(EXCLUDED_INLINE_CONTENT)) return null;
      if (node.nodeType === Node.TEXT_NODE) {
        characters += (node as Text).data.length;
        if (characters > 8000) return null;
        nodes.push(node as Text);
      }
    }
    const text = normalizeWhitespace(nodes.map(node => node.data).join(""));
    return text.length >= 4 && text.length <= 4000 ? { text, nodes } : null;
  }

  #inline(element: Element): boolean {
    if (!this.settings.scanText) return false;
    const snapshot = this.#inlineSnapshot(element);
    if (!snapshot || this.#negativeInline.get(element) === snapshot.text) return false;
    const result = this.#match(snapshot.text);
    if (!result) { this.#negativeInline.set(element, snapshot.text); return false; }
    this.#inlineValues.set(element, snapshot.text);
    for (const node of snapshot.nodes) if (node.data.trim() && node.parentElement && !shouldSkipElement(node.parentElement)) {
      this.redactor.text({ node, text: normalizeWhitespace(node.data) }, result.match, this.settings.redactionStyle, result.ai);
    }
    return true;
  }

  #inlineAround(element: Element | null): boolean {
    let depth = 0;
    for (let parent = element; parent && parent !== document.body && depth++ < MAX_INLINE_NODES; parent = parent.parentElement) {
      if (parent.matches(INLINE_CONTAINERS) && this.#inline(parent)) return true;
    }
    return false;
  }
}
