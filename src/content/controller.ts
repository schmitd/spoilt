import { browser } from "wxt/browser";
import { memoryMatch, normalizeMemory } from "../core/memory";
import { descriptionMatch, keywordMatch, normalizeWhitespace } from "../core/matching";
import { MEMORY_KEY, STATUS_KEY } from "../core/status";
import { MAX_TEXT_BATCH, NATIVE_RETRY_KEY } from "../core/native-ai-protocol";
import type { Settings, SpoilerMemory } from "../core/types";
import { loadSettings, updateStatus } from "../platform/storage";
import { loadMemory } from "../services/memory-service";
import { AiClassifier } from "./ai-classifier";
import { CandidateCollector, imageMetadata, isSpoiltNode, isVisible, Redactor, shouldSkipElement, type TextCandidate, type ImageCandidate } from "./dom";

import { LinkPrefetcher } from "./link-prefetcher";
import { analysisSignature, precomputePage, PreparedTextApplier, type CachedAnalysis } from "./prefetch-analysis";

const SCAN_DEBOUNCE_MS = 150;
const MAX_BUSY_RESCANS = 3;

export class ContentController {
  #settings!: Settings;
  #memory: SpoilerMemory = normalizeMemory();
  #collector = new CandidateCollector();
  #redactor = new Redactor();
  #ai = new AiClassifier();
  #prefetcher = new LinkPrefetcher((url, html, signal) => precomputePage(url, html, this.#settings, this.#memory, signal));
  #prepared: PreparedTextApplier | null = null;
  #observer: MutationObserver | null = null;
  #timer = 0;
  #run = 0;
  #scanRequested = false;
  #scanPromise: Promise<void> | null = null;
  #url = location.href;
  #saveTimer = 0;
  #configuration = 0;
  #starting = true;
  #configurationChanged = false;
  #busyRetryTimer = 0;
  #busyRetryAttempt = 0;

  async start(): Promise<void> {
    browser.runtime.onMessage.addListener((message: unknown) => this.#handleMessage(message));
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[NATIVE_RETRY_KEY]) {
        if (!this.#starting && this.#settings?.enabled && this.#settings.useLocalAI) {
          this.#resetBusyRetry();
          this.#collector.reset();
          this.schedule(0);
        }
        return;
      }
      if (!((area === "sync" && changes["spoilt.settings"]) || (area === "local" && changes[MEMORY_KEY]))) return;
      if (this.#starting) this.#configurationChanged = true;
      else void this.#reloadSettings();
    });
    const cachePromise = Promise.race([
      browser.runtime.sendMessage({ scope: "spoilt", type: "getPrefetchAnalysis" }).catch(() => null) as Promise<CachedAnalysis[] | CachedAnalysis | null>,
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 300)),
    ]);
    let analysis: CachedAnalysis[] | CachedAnalysis | null;
    do {
      this.#configurationChanged = false;
      const [settings, memory, cached] = await Promise.all([loadSettings(), loadMemory(), cachePromise]);
      this.#settings = settings;
      this.#memory = memory;
      analysis = cached;
    } while (this.#configurationChanged);
    this.#starting = false;
    this.#url = location.href;
    this.#prefetcher.setEnabled(this.#settings.enabled && this.#settings.prefetchLinks);
    this.#protect(analysis);
    // Navigation API covers pushState/replaceState without injecting or patching
    // page-world JavaScript. Mutation checks and history events are fallbacks.
    (window as Window & { navigation?: EventTarget }).navigation?.addEventListener("currententrychange", this.#checkRoute);
    window.addEventListener("popstate", this.#checkRoute);
    window.addEventListener("hashchange", this.#checkRoute);
    if (this.#settings.enabled) {
      this.#observe();
      this.schedule(50);
    }
  }

  schedule(delay = SCAN_DEBOUNCE_MS): void {
    if (!this.#settings.enabled || this.#timer) return;
    this.#timer = window.setTimeout(() => {
      this.#timer = 0;
      void this.scan().catch((error) => updateStatus({ lastError: formatError(error) }));
    }, delay);
  }

  async scan(): Promise<void> {
    this.#scanRequested = true;
    if (!this.#scanPromise) {
      this.#scanPromise = this.#drainScans().finally(() => {
        this.#scanPromise = null;
      });
    }
    return this.#scanPromise;
  }

  async #drainScans(): Promise<void> {
    while (this.#scanRequested) {
      this.#scanRequested = false;
      await this.#scanOnce();
      if (this.#scanRequested) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  async #scanOnce(): Promise<void> {
    this.#checkRoute();
    if (!this.#settings.enabled) {
      this.#redactor.clear(this.#collector);
      await updateStatus({ enabled: false, counters: this.#redactor.counters, pendingText: 0, pendingImages: 0 });
      return;
    }
    const settings = this.#settings;
    const memory = this.#memory;
    const run = ++this.#run;
    const signature = this.#signature(settings, memory);
    const configuration = this.#configuration;
    const url = this.#url;
    const isCurrent = () => run === this.#run && configuration === this.#configuration && url === location.href;
    const textCandidates = settings.scanText ? this.#collector.collectText(settings, signature,
      settings.useLocalAI ? Math.min(settings.maxTextNodesPerScan, MAX_TEXT_BATCH * 2) : settings.maxTextNodesPerScan) : [];
    const imageCandidates = settings.scanImages ? this.#collector.collectImages(settings, signature) : [];
    const aiText: TextCandidate[] = [];
    const aiImages: ImageCandidate[] = [];
    let busy = false;

    for (const candidate of textCandidates) {
      const match = this.#match(candidate.text, settings, memory);
      if (match) this.#redactor.text(candidate, match, settings.redactionStyle);
      else aiText.push(candidate);
    }
    for (const candidate of imageCandidates) {
      const match = this.#match(candidate.metadataText, settings, memory);
      if (match) this.#redactor.image(candidate, match, settings.redactionStyle);
      else aiImages.push(candidate);
    }

    await updateStatus({
      enabled: true,
      lastScanAt: new Date().toISOString(),
      pendingText: aiText.length,
      pendingImages: aiImages.length,
      counters: this.#redactor.counters,
    });

    const analyzeText = async () => {
      if (!settings.useLocalAI || !aiText.length) return;
      await this.#ai.text(aiText, settings, memory, (candidate, match) => {
        if (!isCurrent()) return;
        // Cache admission is optional: a valid live decision must still conceal
        // an unchanged original even when its text exceeds the cache limit.
        this.#redactor.text(candidate, match, settings.redactionStyle, true);
        // Retain the decision even when hydration detached the original node;
        // apply only to the exact classified text on this route.
        this.#prepared?.rememberText(candidate.text, match);
        this.#saveDecisions();
      }, isCurrent, undefined, (candidates) => {
        if (isCurrent()) {
          busy = true;
          this.#collector.retryText(candidates, signature);
        }
      }, (limit) => {
        if (!isCurrent() || !settings.scanText) return [];
        const more = this.#collector.collectText(settings, signature, limit);
        return more.filter((candidate) => {
          const match = this.#match(candidate.text, settings, memory);
          if (!match) return true;
          this.#redactor.text(candidate, match, settings.redactionStyle);
          return false;
        });
      });
    };
    const analyzeImages = async () => {
      if (!settings.useLocalAI || !settings.useVision || !aiImages.length) return;
      await this.#ai.images(aiImages, settings, memory, (candidate, match) => {
        if (!isCurrent() || imageMetadata(candidate.element) !== candidate.metadataText) return;
        this.#prepared?.rememberImage(candidate.element, match);
        this.#redactor.image(candidate, match, settings.redactionStyle, true);
        this.#saveDecisions();
      }, isCurrent, (candidates) => {
        if (isCurrent()) {
          busy = true;
          this.#collector.retryImages(candidates, signature);
        }
      });
    };
    // The host owns the fair serialized queue. Let each modality submit bounded
    // work so image protection need not wait for every text batch on this page.
    await Promise.all([analyzeText(), analyzeImages()]);
    if (run === this.#run) {
      if (busy) this.#scheduleBusyRetry();
      else if (aiText.length || aiImages.length) this.#resetBusyRetry();
      await updateStatus({ counters: this.#redactor.counters, pendingText: 0, pendingImages: 0 });
      if (!busy && isCurrent() && ((settings.scanText && this.#collector.hasPendingText) || (settings.scanImages && this.#collector.hasPendingImages))) this.#scanRequested = true;
    }
  }

  async #reloadSettings(): Promise<void> {
    this.#resetBusyRetry();
    const configuration = ++this.#configuration;
    const previous = this.#settings && this.#prepared?.snapshot(analysisSignature(this.#settings, this.#memory));
    this.#prefetcher.setEnabled(false);
    this.#run += 1;
    window.clearTimeout(this.#saveTimer);
    this.#saveTimer = 0;
    this.#prepared?.stop();
    this.#prepared = null;
    const [settings, memory] = await Promise.all([loadSettings(), loadMemory()]);
    if (configuration !== this.#configuration) return;
    this.#settings = settings;
    this.#memory = memory;
    this.#prefetcher.setEnabled(this.#settings.enabled && this.#settings.prefetchLinks);
    void this.#ai.reset();
    this.#redactor.clear(this.#collector);
    this.#protect(previous ?? null);
    if (this.#settings.enabled) {
      this.#observe();
      this.schedule(50);
    } else {
      this.#disconnect();
      await updateStatus({ enabled: false, counters: this.#redactor.counters });
    }
  }

  #match(text: string, settings: Settings, memory: SpoilerMemory) {
    return keywordMatch(text, settings.rules)
      || memoryMatch(text, settings.rules, memory)
      || descriptionMatch(text, settings.rules);
  }

  #observe(): void {
    if (this.#observer) return;
    this.#observer = new MutationObserver((mutations) => {
      this.#checkRoute();
      const relevant = mutations.filter((mutation) => (
        !isSpoiltNode(mutation.target)
        && (mutation.type === "characterData" || mutation.type === "attributes" || [...mutation.addedNodes].some((node) => !isSpoiltNode(node)))
      ));
      if (!relevant.length) return;
      this.#collector.enqueueRoots(relevant.flatMap((mutation) => mutation.type === "childList" ? [...mutation.addedNodes] : [mutation.target]));
      this.#redactChanges(relevant);
      this.schedule();
    });
    this.#observer.observe(document, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["src", "srcset", "alt", "title", "poster", "data-src", "data-srcset", "hidden", "aria-hidden", "class", "style"],
    });
    document.addEventListener("load", this.#imageLoaded, true);
  }

  #redactChanges(mutations: MutationRecord[]): void {
    if (!this.#settings.enabled) return;
    let remaining = this.#settings.scanText ? this.#settings.maxTextNodesPerScan : 0;
    let remainingImages = this.#settings.scanImages ? this.#settings.maxImagesPerScan : 0;
    const inspect = (node: Text) => {
      if (remaining-- <= 0 || !node.parentElement) return;
      const text = normalizeWhitespace(node.data);
      if (text.length < 4) return;
      const match = this.#match(text, this.#settings, this.#memory);
      if (match && !shouldSkipElement(node.parentElement) && isVisible(node.parentElement)) {
        this.#redactor.text({ node, text }, match, this.#settings.redactionStyle);
      }
    };
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && (mutation.attributeName === "class" || mutation.attributeName === "style")) continue;
      const roots = mutation.type === "characterData" || mutation.type === "attributes" ? [mutation.target] : [...mutation.addedNodes];
      for (const root of roots) {
        if (remaining <= 0 && remainingImages <= 0) return;
        if (root instanceof Element && remainingImages > 0 && !isSpoiltNode(root)) {
          const images = root.matches("img,picture,video[poster],svg[role='img'],canvas") ? [root] : [];
          images.push(...root.querySelectorAll("img,picture,video[poster],svg[role='img'],canvas"));
          for (const image of images.slice(0, remainingImages)) { this.#redactImage(image); remainingImages -= 1; }
        }
        if (remaining <= 0) continue;
        if (root.nodeType === Node.TEXT_NODE) { inspect(root as Text); continue; }
        if (root.nodeType !== Node.ELEMENT_NODE || isSpoiltNode(root)) continue;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        // Collect first: replacing a text node while walking can truncate traversal.
        const nodes: Text[] = [];
        for (let node = walker.nextNode(); node && nodes.length < remaining; node = walker.nextNode()) nodes.push(node as Text);
        nodes.forEach(inspect);
      }
    }
  }

  #imageLoaded = (event: Event): void => {
    if (event.target instanceof HTMLImageElement) this.#redactImage(event.target);
  };

  #redactImage(element: Element): void {
    if (!this.#settings.enabled || !this.#settings.scanImages || shouldSkipElement(element) || !isVisible(element)) return;
    const rect = element.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 24) return;
    const metadataText = imageMetadata(element);
    const match = this.#match(metadataText, this.#settings, this.#memory);
    if (match) this.#redactor.image({ element: element.closest("picture") ?? element, metadataText }, match, this.#settings.redactionStyle);
  }

  #disconnect(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    document.removeEventListener("load", this.#imageLoaded, true);
  }

  #protect(analyses: CachedAnalysis[] | CachedAnalysis | null): void {
    this.#prepared?.stop();
    this.#prepared = null;
    if (!this.#settings.enabled) return;
    const signature = analysisSignature(this.#settings, this.#memory);
    const candidates = Array.isArray(analyses) ? analyses : analyses ? [analyses] : [];
    const analysis = candidates.find((analysis) => (analysis.kind === "live" || this.#settings.prefetchLinks)
      && analysis.url === location.href && analysis.signature === signature
      && Date.now() - analysis.createdAt >= 0 && Date.now() - analysis.createdAt <= 60_000
      && Array.isArray(analysis.matches));
    this.#prepared = new PreparedTextApplier(this.#redactor, this.#settings,
      analysis ?? { url: location.href, signature, createdAt: Date.now(), matches: [] }, this.#memory);
    this.#prepared.start();
  }

  #checkRoute = (): void => {
    if (location.href === this.#url || !this.#settings) return;
    this.#resetBusyRetry();
    this.#url = location.href;
    this.#run += 1;
    void this.#ai.reset();
    window.clearTimeout(this.#saveTimer);
    this.#saveTimer = 0;
    this.#prepared?.stop();
    this.#redactor.clear(this.#collector);
    this.#protect(null);
    this.schedule(0);
  };

  #scheduleBusyRetry(): void {
    if (this.#busyRetryTimer || this.#busyRetryAttempt >= MAX_BUSY_RESCANS) return;
    const configuration = this.#configuration;
    const url = this.#url;
    const delay = Math.round(1000 * 2 ** this.#busyRetryAttempt++ * (0.75 + Math.random() / 2));
    this.#busyRetryTimer = window.setTimeout(() => {
      this.#busyRetryTimer = 0;
      if (configuration === this.#configuration && url === location.href && this.#settings.enabled && this.#settings.useLocalAI) this.schedule(0);
    }, delay);
  }

  #resetBusyRetry(): void {
    window.clearTimeout(this.#busyRetryTimer);
    this.#busyRetryTimer = 0;
    this.#busyRetryAttempt = 0;
  }

  #saveDecisions(): void {
    if (this.#saveTimer) return;
    const configuration = this.#configuration;
    this.#saveTimer = window.setTimeout(() => {
      this.#saveTimer = 0;
      if (configuration !== this.#configuration || this.#url !== location.href || !this.#prepared) return;
      const analysis = this.#prepared.snapshot(analysisSignature(this.#settings, this.#memory));
      void browser.runtime.sendMessage({ scope: "spoilt", type: "savePageAnalysis", analysis }).catch(() => undefined);
    }, 100);
  }

  #signature(settings: Settings, memory: SpoilerMemory): string {
    return JSON.stringify({
      strictness: settings.strictness,
      text: settings.scanText,
      images: settings.scanImages,
      ai: settings.useLocalAI,
      vision: settings.useVision,
      style: settings.redactionStyle,
      memory: memory.lastUpdatedAt,
      rules: settings.rules,
    });
  }

  async #handleMessage(message: unknown): Promise<unknown> {
    if (!isMessage(message)) return { ok: false, error: "Unknown message." };
    if (message.type === "scan") {
      await this.#reloadSettings();
      await this.scan();
      return { ok: true, status: await this.#status() };
    }
    if (message.type === "status") return { ok: true, status: await this.#status() };
    if (message.type === "resetAI") {
      this.#run += 1;
      await this.#ai.reset();
      await updateStatus({ lastError: "" });
      return { ok: true, status: await this.#status() };
    }
    if (message.type === "clear") {
      this.#prepared?.stop();
      this.#prepared = null;
      this.#redactor.clear(this.#collector);
      await updateStatus({ counters: this.#redactor.counters, pendingText: 0, pendingImages: 0 });
      return { ok: true, status: await this.#status() };
    }
    return { ok: false, error: "Unsupported message." };
  }

  async #status(): Promise<unknown> {
    return (await browser.storage.local.get(STATUS_KEY))[STATUS_KEY] ?? {};
  }
}

function isMessage(value: unknown): value is { scope: "spoilt"; type: string } {
  return Boolean(value) && typeof value === "object" && (value as { scope?: string }).scope === "spoilt";
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
