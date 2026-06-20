import { browser } from "wxt/browser";
import { memoryMatch, normalizeMemory } from "../core/memory";
import { descriptionMatch, keywordMatch } from "../core/matching";
import { MEMORY_KEY, STATUS_KEY } from "../core/status";
import type { Settings, SpoilerMemory } from "../core/types";
import { loadSettings, updateStatus } from "../platform/storage";
import { loadMemory } from "../services/memory-service";
import { AiClassifier } from "./ai-classifier";
import { CandidateCollector, isSpoiltNode, Redactor } from "./dom";

const SCAN_DEBOUNCE_MS = 900;

export class ContentController {
  #settings!: Settings;
  #memory: SpoilerMemory = normalizeMemory();
  #collector = new CandidateCollector();
  #redactor = new Redactor();
  #ai = new AiClassifier();
  #observer: MutationObserver | null = null;
  #timer = 0;
  #run = 0;
  #scanRequested = false;
  #scanPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    this.#settings = await loadSettings();
    this.#memory = await loadMemory();
    browser.runtime.onMessage.addListener((message: unknown) => this.#handleMessage(message));
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes["spoilt.settings"]) {
        void this.#reloadSettings();
      }
      if (area === "local" && changes[MEMORY_KEY]) {
        this.#memory = normalizeMemory(changes[MEMORY_KEY].newValue as Partial<SpoilerMemory>);
        this.#collector.reset();
        this.schedule();
      }
    });
    if (this.#settings.enabled) {
      this.#observe();
      this.schedule(50);
    }
  }

  schedule(delay = SCAN_DEBOUNCE_MS): void {
    window.clearTimeout(this.#timer);
    if (!this.#settings.enabled) return;
    this.#timer = window.setTimeout(() => {
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
    }
  }

  async #scanOnce(): Promise<void> {
    if (!this.#settings.enabled) {
      this.#redactor.clear(this.#collector);
      await updateStatus({ enabled: false, counters: this.#redactor.counters, pendingText: 0, pendingImages: 0 });
      return;
    }
    const settings = this.#settings;
    const memory = this.#memory;
    const run = ++this.#run;
    const signature = this.#signature(settings, memory);
    const textCandidates = settings.scanText ? this.#collector.collectText(settings, signature) : [];
    const imageCandidates = settings.scanImages ? this.#collector.collectImages(settings, signature) : [];
    const aiText = [];
    const aiImages = [];

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

    if (settings.useLocalAI && aiText.length) {
      await this.#ai.text(aiText, settings, memory, (candidate, match) => {
        this.#redactor.text(candidate, match, settings.redactionStyle, true);
      }, () => run === this.#run);
    }
    if (settings.useLocalAI && settings.useVision && aiImages.length) {
      await this.#ai.images(aiImages, settings, memory, (candidate, match) => {
        this.#redactor.image(candidate, match, settings.redactionStyle, true);
      }, () => run === this.#run);
    }
    if (run === this.#run) {
      await updateStatus({ counters: this.#redactor.counters, pendingText: 0, pendingImages: 0 });
    }
  }

  async #reloadSettings(): Promise<void> {
    this.#settings = await loadSettings();
    this.#run += 1;
    await this.#ai.reset();
    this.#redactor.clear(this.#collector);
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
      if (mutations.some((mutation) => (
        !(mutation.target && isSpoiltNode(mutation.target))
        && (mutation.type === "characterData" || [...mutation.addedNodes].some((node) => !isSpoiltNode(node)))
      ))) this.schedule();
    });
    this.#observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  #disconnect(): void {
    this.#observer?.disconnect();
    this.#observer = null;
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
      this.#settings = await loadSettings();
      this.#memory = await loadMemory();
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
