import { normalizeWhitespace } from "../core/matching";
import type { BlockingRule, Match, RedactionStyle, ScanCounters, Settings } from "../core/types";
import { browser } from "wxt/browser";

export const MASKED_TEXT_CLASS = "spoilt-redacted-text";
export const IMAGE_SHELL_CLASS = "spoilt-image-shell";
export const BACKGROUND_CLASS = "spoilt-background-redacted";

export interface TextCandidate {
  node: Text;
  text: string;
}

export interface ImageCandidate {
  element: Element;
  metadataText: string;
}

export class CandidateCollector {
  #processedText = new WeakMap<Text, string>();
  #processedImages = new WeakMap<Element, string>();
  #textTraversal: Generator<Node> | null = null;
  #textRoot: Node | null = null;
  #textSignature = "";
  #deferredText = new Map<Text, TextCandidate>();
  #textComplete = false;
  #freshRoots = new Set<Node>();
  #freshTraversals: Generator<Node>[] = [];
  #freshText = new Map<Text, TextCandidate>();
  #restartTextAfterPass = false;
  #imageElements: Element[] | null = null;
  #imageIndex = 0;
  #imageSignature = "";
  #deferredImages = new Map<Element, ImageCandidate>();
  #imagesComplete = false;

  get hasPendingText(): boolean { return Boolean(!this.#textComplete || this.#restartTextAfterPass || this.#textTraversal || this.#deferredText.size || this.#freshRoots.size || this.#freshTraversals.length || this.#freshText.size); }
  get hasPendingImages(): boolean { return Boolean(!this.#imagesComplete || this.#imageElements || this.#deferredImages.size); }

  enqueueRoots(roots: Iterable<Node>): void {
    for (const root of roots) {
      if (!root.isConnected || isSpoiltNode(root)) continue;
      // Coalesce mutations in the same newly inserted subtree before walking it.
      if ([...this.#freshRoots].some((existing) => existing.contains(root))) continue;
      for (const existing of this.#freshRoots) if (root.contains(existing)) this.#freshRoots.delete(existing);
      if (this.#freshRoots.size < 64) this.#freshRoots.add(root);
      else this.#deferFullTraversal();
    }
    // A fresh image snapshot is cheap and also sees inserted/replaced elements
    // that precede an older snapshot's cursor. Already processed images are skipped.
    this.#imageElements = null; this.#imageIndex = 0; this.#imagesComplete = false;
  }

  collectText(settings: Settings, signature: string, limit = settings.maxTextNodesPerScan): TextCandidate[] {
    const root = document.body || document.documentElement;
    if (this.#textRoot !== root || this.#textSignature !== signature) {
      this.#textTraversal?.return(undefined);
      this.#textTraversal = null;
      this.#deferredText.clear();
      this.#textComplete = false;
      this.#clearFreshText();
      this.#textRoot = root;
      this.#textSignature = signature;
    }
    for (const pool of [this.#deferredText, this.#freshText]) for (const [node, candidate] of pool) {
      if (!this.#eligibleText(node, candidate.text, signature)) pool.delete(node);
    }
    for (const freshRoot of this.#freshRoots) {
      this.#freshTraversals.unshift(walkDocumentNodes(freshRoot));
      if (this.#freshTraversals.length > 64) { this.#freshTraversals.pop()!.return(undefined); this.#deferFullTraversal(); }
    }
    this.#freshRoots.clear();
    let freshVisits = 1000;
    while (this.#freshTraversals.length && freshVisits-- > 0 && this.#freshText.size < 72) {
      const step = this.#freshTraversals[0]!.next();
      if (step.done) { this.#freshTraversals.shift(); continue; }
      if (step.value.nodeType !== Node.TEXT_NODE) continue;
      const node = step.value as Text; const text = normalizeWhitespace(node.data);
      if (this.#eligibleText(node, text, signature)) this.#freshText.set(node, { node, text });
    }
    if (!this.#textComplete) this.#textTraversal ??= walkDocumentNodes(root);
    // Look beyond the returned batch, but bound both traversal and retained work.
    // The cursor resumes later so a large page cannot lose its deferred tail.
    const pendingLimit = Math.max(72, settings.maxTextNodesPerScan * 4);
    let visits = Math.max(4000, settings.maxTextNodesPerScan * 4);
    while (this.#textTraversal && visits-- > 0 && this.#deferredText.size < pendingLimit) {
      const step = this.#textTraversal.next();
      if (step.done) {
        this.#textTraversal = null; this.#textComplete = !this.#restartTextAfterPass; this.#restartTextAfterPass = false; break;
      }
      if (step.value.nodeType !== Node.TEXT_NODE) continue;
      const node = step.value as Text;
      const text = normalizeWhitespace(node.data);
      if (this.#eligibleText(node, text, signature)) this.#deferredText.set(node, { node, text });
    }
    const pool = new Map([...this.#deferredText, ...this.#freshText]);
    const candidates = viewportFirst([...pool.values()], (candidate) => candidate.node.parentElement,
      Math.max(1, Math.min(limit, settings.maxTextNodesPerScan)));
    for (const candidate of candidates) {
      this.#deferredText.delete(candidate.node);
      this.#freshText.delete(candidate.node);
      this.#processedText.set(candidate.node, `${signature}:${candidate.text}`);
    }
    return candidates;
  }

  collectImages(settings: Settings, signature: string): ImageCandidate[] {
    if (this.#imageSignature !== signature) {
      this.#imageElements = null; this.#imageIndex = 0; this.#deferredImages.clear(); this.#imageSignature = signature; this.#imagesComplete = false;
    }
    for (const [element, candidate] of this.#deferredImages) {
      if (!element.isConnected || imageMetadata(element) !== candidate.metadataText
        || this.#processedImages.get(element) === `${signature}:${candidate.metadataText}`) this.#deferredImages.delete(element);
    }
    if (!this.#imagesComplete) this.#imageElements ??= [...document.querySelectorAll("img, picture, svg[role='img'], video[poster], canvas")];
    const pendingLimit = Math.max(48, settings.maxImagesPerScan * 4);
    let visits = pendingLimit;
    while (this.#imageElements && this.#imageIndex < this.#imageElements.length && visits-- > 0 && this.#deferredImages.size < pendingLimit) {
      const element = this.#imageElements[this.#imageIndex++]!;
      const metadataText = imageMetadata(element);
      if (!element.isConnected || this.#processedImages.get(element) === `${signature}:${metadataText}` || shouldSkipElement(element) || !isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) continue;
      this.#deferredImages.set(element, { element, metadataText });
    }
    if (this.#imageElements && this.#imageIndex >= this.#imageElements.length) { this.#imageElements = null; this.#imageIndex = 0; this.#imagesComplete = true; }
    const candidates = viewportFirst([...this.#deferredImages.values()], (candidate) => candidate.element, settings.maxImagesPerScan);
    for (const candidate of candidates) {
      this.#deferredImages.delete(candidate.element);
      this.#processedImages.set(candidate.element, `${signature}:${candidate.metadataText}`);
    }
    return candidates;
  }

  #eligibleText(node: Text, text: string, signature: string): boolean {
    const parent = node.parentElement;
    return Boolean(parent && node.isConnected && text.length >= 4 && normalizeWhitespace(node.data) === text
      && this.#processedText.get(node) !== `${signature}:${text}` && !shouldSkipElement(parent) && isVisible(parent));
  }

  retryText(candidates: TextCandidate[], signature: string): void {
    for (const { node, text } of candidates) {
      if (this.#processedText.get(node) === `${signature}:${text}`) this.#processedText.delete(node);
    }
    this.#deferredText = new Map([...candidates.map((candidate) => [candidate.node, candidate] as const), ...this.#deferredText]);
  }

  retryImages(candidates: ImageCandidate[], signature: string): void {
    for (const { element, metadataText } of candidates) {
      if (this.#processedImages.get(element) === `${signature}:${metadataText}`) this.#processedImages.delete(element);
    }
    this.#deferredImages = new Map([...candidates.map((candidate) => [candidate.element, candidate] as const), ...this.#deferredImages]);
  }

  reset(): void {
    this.#processedText = new WeakMap();
    this.#processedImages = new WeakMap();
    this.#textTraversal?.return(undefined); this.#textTraversal = null; this.#textRoot = null;
    this.#deferredText.clear(); this.#deferredImages.clear(); this.#imageElements = null; this.#imageIndex = 0;
    this.#textComplete = false; this.#imagesComplete = false; this.#clearFreshText();
  }

  #clearFreshText(): void {
    for (const traversal of this.#freshTraversals) traversal.return(undefined);
    this.#freshTraversals = []; this.#freshRoots.clear(); this.#freshText.clear(); this.#restartTextAfterPass = false;
  }

  #deferFullTraversal(): void {
    if (this.#textComplete) { this.#textComplete = false; this.#restartTextAfterPass = false; }
    else this.#restartTextAfterPass = true;
  }
}

export function inViewport(element: Element | null): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
    && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

function viewportFirst<T>(candidates: T[], element: (candidate: T) => Element | null, limit: number): T[] {
  const selected = new Set<T>();
  // Reserve a quarter of every full collection for the oldest deferred work.
  const foregroundSlots = Math.max(1, limit - Math.floor(limit / 4));
  for (const candidate of candidates) {
    if (selected.size >= foregroundSlots) break;
    if (inViewport(element(candidate))) selected.add(candidate);
  }
  for (const candidate of candidates) {
    if (selected.size >= limit) break;
    selected.add(candidate);
  }
  return [...selected];
}

function* walkDocumentNodes(root: Node): Generator<Node> {
  const stack: Array<{ parent: Node; cursor: Range }> = [];
  let next: Node | null = root;
  try {
    while (next || stack.length) {
      if (next) {
        const node: Node = next; next = null;
        if (!node.isConnected || (node instanceof Element && shouldSkipElement(node))) continue;
        yield node;
        if (node.isConnected && node.firstChild && !isSpoiltNode(node)) {
          const cursor = document.createRange(); cursor.setStart(node, 0); cursor.collapse(true);
          stack.push({ parent: node, cursor });
        }
      } else {
        const frame = stack[stack.length - 1]!;
        if (!frame.parent.isConnected || frame.cursor.startContainer !== frame.parent) { frame.cursor.detach(); stack.pop(); continue; }
        next = frame.parent.childNodes.item(frame.cursor.startOffset);
        if (!next) { frame.cursor.detach(); stack.pop(); continue; }
        frame.cursor.setStart(frame.parent, frame.cursor.startOffset + 1); frame.cursor.collapse(true);
      }
    }
  } finally { for (const frame of stack) frame.cursor.detach(); }
}

export class Redactor {
  counters: ScanCounters = { text: 0, images: 0, aiText: 0, aiImages: 0 };
  #textValues = new WeakMap<Element, string>();
  #imageValues = new WeakMap<Element, string>();

  text(candidate: TextCandidate, match: Match, style: RedactionStyle, ai = false): void {
    const parent = candidate.node.parentElement;
    if (!candidate.node.isConnected || !parent || shouldSkipElement(parent)
      || normalizeWhitespace(candidate.node.data) !== candidate.text || !candidate.node.nodeValue) return;
    const span = document.createElement("span");
    span.className = MASKED_TEXT_CLASS;
    span.textContent = candidate.node.nodeValue;
    span.title = `Spoilt concealed: ${match.ruleName}`;
    span.setAttribute("aria-label", "Spoilt concealed content");
    span.dataset.spoiltReason = match.reason;
    span.dataset.spoiltRuleId = match.ruleId;
    span.dataset.spoiltStyle = style;
    parent.replaceChild(span, candidate.node);
    this.#textValues.set(span, normalizeWhitespace(span.textContent));
    this.counters.text += 1;
    if (ai) this.counters.aiText += 1;
  }

  image(candidate: ImageCandidate, match: Match, style: RedactionStyle, ai = false): void {
    const element = candidate.element;
    if (!element.parentNode || element.closest(`.${IMAGE_SHELL_CLASS}`)) return;
    const shell = document.createElement("span");
    shell.className = IMAGE_SHELL_CLASS;
    shell.title = `Spoilt concealed image: ${match.ruleName}`;
    shell.setAttribute("aria-label", "Spoilt concealed image");
    shell.dataset.spoiltReason = match.reason;
    shell.dataset.spoiltRuleId = match.ruleId;
    shell.dataset.spoiltStyle = style;
    const rect = element.getBoundingClientRect();
    if (rect.width && rect.height) {
      shell.style.width = `${Math.ceil(rect.width)}px`;
      shell.style.height = `${Math.ceil(rect.height)}px`;
    }
    element.parentNode.insertBefore(shell, element);
    shell.appendChild(element);
    this.#imageValues.set(shell, imageMetadata(element));
    this.counters.images += 1;
    if (ai) this.counters.aiImages += 1;
  }

  clear(collector: CandidateCollector): void {
    document.querySelectorAll(`.${MASKED_TEXT_CLASS}`).forEach((span) => {
      span.replaceWith(document.createTextNode(span.textContent || ""));
    });
    document.querySelectorAll(`.${IMAGE_SHELL_CLASS}`).forEach((shell) => {
      const parent = shell.parentNode;
      if (!parent) return;
      while (shell.firstChild) parent.insertBefore(shell.firstChild, shell);
      shell.remove();
    });
    document.querySelectorAll(`.${BACKGROUND_CLASS}`).forEach((element) => {
      element.classList.remove(BACKGROUND_CLASS);
      element.removeAttribute("data-spoilt-reason");
    });
    collector.reset();
    this.counters = { text: 0, images: 0, aiText: 0, aiImages: 0 };
  }

  relabel(rules: BlockingRule[]): void {
    for (const element of document.querySelectorAll<HTMLElement>(`.${MASKED_TEXT_CLASS}, .${IMAGE_SHELL_CLASS}`)) {
      const rule = rules.find((item) => item.id === element.dataset.spoiltRuleId);
      if (rule) element.title = `Spoilt concealed${element.classList.contains(IMAGE_SHELL_CLASS) ? " image" : ""}: ${rule.name}`;
    }
  }

  restoreChanged(node: Node): Node {
    const element = node instanceof Element ? node : node.parentElement;
    const textMask = element?.closest(`.${MASKED_TEXT_CLASS}`);
    if (textMask && this.#textValues.get(textMask) !== normalizeWhitespace(textMask.textContent)) {
      const parent = textMask.parentElement;
      textMask.replaceWith(...textMask.childNodes);
      return parent ?? node;
    }
    const imageMask = element?.closest(`.${IMAGE_SHELL_CLASS}`);
    const image = imageMask?.firstElementChild;
    if (imageMask && image && this.#imageValues.get(imageMask) !== imageMetadata(image)) {
      const parent = imageMask.parentElement;
      imageMask.replaceWith(...imageMask.childNodes);
      return parent ?? node;
    }
    return node;
  }

  restoreTextWithin(element: Element): void {
    for (const span of element.querySelectorAll(`.${MASKED_TEXT_CLASS}`)) span.replaceWith(...span.childNodes);
  }
}

export function isSpoiltNode(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  return Boolean(element?.closest(`.${MASKED_TEXT_CLASS}, .${IMAGE_SHELL_CLASS}, .${BACKGROUND_CLASS}`));
}

export async function promptImageInput(element: Element): Promise<Element | Blob | null> {
  const image = promptImageElement(element);
  const source = image instanceof HTMLImageElement
    ? image.currentSrc || image.src
    : image.getAttribute("poster") || image.getAttribute("href") || "";
  if (!source) return image;
  if (/^data:/i.test(source)) return fetch(source).then((response) => response.blob());
  if (/^blob:/i.test(source) || isSameOrigin(source)) return image;
  try {
    const response = await browser.runtime.sendMessage({ scope: "spoilt", type: "fetchImageDataUrl", url: source }) as {
      ok?: boolean;
      result?: { dataUrl?: string };
    };
    if (!response?.ok || !response.result?.dataUrl) return null;
    return fetch(response.result.dataUrl).then((result) => result.blob());
  } catch {
    return null;
  }
}

export function shouldSkipElement(element: Element): boolean {
  if (element.closest(`.${MASKED_TEXT_CLASS}, .${IMAGE_SHELL_CLASS}, .${BACKGROUND_CLASS}`)) return true;
  return Boolean(element.closest('head,script,style,noscript,template,textarea,input,select,option,code,pre,kbd,samp,[data-spoilt-ui],[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"]'));
}

export function isVisible(element: Element): boolean {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function imageMetadata(element: Element, baseUrl = location.href): string {
  const image = promptImageElement(element);
  const parts = [
    image.getAttribute("alt"),
    image.getAttribute("title"),
    image.getAttribute("aria-label"),
    image.getAttribute("poster"),
    ...imageSourceUrls(image, baseUrl),
    nearestCaptionText(element),
  ];
  return normalizeWhitespace(parts.filter(Boolean).join(" ")).slice(0, 1000);
}

export function imageSourceUrls(element: Element, baseUrl: string): string[] {
  const image = promptImageElement(element);
  const values = [image instanceof HTMLImageElement ? image.currentSrc : "", image.getAttribute("src"), image.getAttribute("data-src"), image.getAttribute("poster"), image.getAttribute("href")];
  const sets = [image.getAttribute("srcset"), image.getAttribute("data-srcset")];
  const picture = image.closest("picture");
  if (picture) for (const source of picture.querySelectorAll("source[srcset]")) sets.push(source.getAttribute("srcset"));
  for (const set of sets) {
    // Responsive image URLs are comma-separated, followed by width/density.
    // Data URLs are intentionally excluded from metadata identities.
    if (!set || /^data:/i.test(set)) continue;
    values.push(...set.split(",").map((entry) => entry.trim().split(/\s+/)[0] || ""));
  }
  const urls = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    try {
      const url = new URL(value, baseUrl);
      if (/^https?:$/.test(url.protocol)) urls.add(url.href);
    } catch { /* Ignore malformed image sources. */ }
    if (urls.size >= 8) break;
  }
  return [...urls];
}

function promptImageElement(element: Element): Element {
  return element.tagName.toLowerCase() === "picture" ? element.querySelector("img") || element : element;
}

function nearestCaptionText(element: Element): string {
  const caption = element.closest("figure")?.querySelector("figcaption");
  return caption?.textContent || element.parentElement?.getAttribute("aria-label") || "";
}

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}
