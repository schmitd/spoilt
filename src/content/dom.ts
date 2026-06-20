import { normalizeWhitespace } from "../core/matching";
import type { Match, RedactionStyle, ScanCounters, Settings } from "../core/types";
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

  collectText(settings: Settings, signature: string): TextCandidate[] {
    const candidates: TextCandidate[] = [];
    const root = document.body || document.documentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (candidates.length >= settings.maxTextNodesPerScan) return NodeFilter.FILTER_REJECT;
        const textNode = node as Text;
        const text = normalizeWhitespace(textNode.nodeValue);
        if (!text || text.length < 4 || this.#processedText.get(textNode) === `${signature}:${text}`) return NodeFilter.FILTER_REJECT;
        const parent = textNode.parentElement;
        if (!parent || shouldSkipElement(parent) || !isVisible(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node = walker.nextNode() as Text | null;
    while (node && candidates.length < settings.maxTextNodesPerScan) {
      const text = normalizeWhitespace(node.nodeValue);
      this.#processedText.set(node, `${signature}:${text}`);
      candidates.push({ node, text });
      node = walker.nextNode() as Text | null;
    }
    return candidates;
  }

  collectImages(settings: Settings, signature: string): ImageCandidate[] {
    const candidates: ImageCandidate[] = [];
    const elements = document.querySelectorAll("img, picture, svg[role='img'], video[poster], canvas");
    for (const element of elements) {
      if (candidates.length >= settings.maxImagesPerScan) break;
      const metadataText = imageMetadata(element);
      if (this.#processedImages.get(element) === `${signature}:${metadataText}` || shouldSkipElement(element) || !isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) continue;
      this.#processedImages.set(element, `${signature}:${metadataText}`);
      candidates.push({ element, metadataText });
    }
    return candidates;
  }

  reset(): void {
    this.#processedText = new WeakMap();
    this.#processedImages = new WeakMap();
  }
}

export class Redactor {
  counters: ScanCounters = { text: 0, images: 0, aiText: 0, aiImages: 0 };

  text(candidate: TextCandidate, match: Match, style: RedactionStyle, ai = false): void {
    if (!candidate.node.parentNode || !candidate.node.nodeValue) return;
    const span = document.createElement("span");
    span.className = MASKED_TEXT_CLASS;
    span.textContent = candidate.node.nodeValue;
    span.title = `Spoilt concealed: ${match.ruleName}`;
    span.setAttribute("aria-label", "Spoilt concealed content");
    span.dataset.spoiltReason = match.reason;
    span.dataset.spoiltStyle = style;
    candidate.node.parentNode.replaceChild(span, candidate.node);
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
    shell.dataset.spoiltStyle = style;
    const rect = element.getBoundingClientRect();
    if (rect.width && rect.height) {
      shell.style.width = `${Math.ceil(rect.width)}px`;
      shell.style.height = `${Math.ceil(rect.height)}px`;
    }
    element.parentNode.insertBefore(shell, element);
    shell.appendChild(element);
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

function shouldSkipElement(element: Element): boolean {
  if (element.closest(`.${MASKED_TEXT_CLASS}, .${IMAGE_SHELL_CLASS}, .${BACKGROUND_CLASS}`)) return true;
  const tag = element.tagName.toLowerCase();
  return ["script", "style", "noscript", "template", "textarea", "input", "select", "option", "code", "pre", "kbd", "samp"].includes(tag)
    || (element instanceof HTMLElement && element.isContentEditable)
    || element.getAttribute("aria-hidden") === "true";
}

function isVisible(element: Element): boolean {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function imageMetadata(element: Element): string {
  const image = promptImageElement(element);
  const parts = [
    image.getAttribute("alt"),
    image.getAttribute("title"),
    image.getAttribute("aria-label"),
    image.getAttribute("poster"),
    image instanceof HTMLImageElement ? image.currentSrc : "",
    image instanceof HTMLImageElement ? image.src : "",
    nearestCaptionText(element),
  ];
  return normalizeWhitespace(parts.filter(Boolean).join(" ")).slice(0, 1000);
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
