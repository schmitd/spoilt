import type { BlockingRule, Match, Settings, SpoilerMemory } from "../core/types";
import { MAX_IMAGE_BYTES, MAX_TEXT_BATCH, MAX_TEXT_LENGTH } from "../core/native-ai-protocol";
import { NativeAiClient } from "../platform/native-ai-client";
import { normalizeWhitespace } from "../core/matching";
import { criteriaSettings, relabelMatch } from "../core/rule-criteria";
import { matchingMemorySignature } from "../core/memory";
import { inViewport, promptImageInput, type ImageCandidate, type TextCandidate } from "./dom";

type Priority = "foreground" | "background" | "speculative";
export interface ClassifierDiagnostics {
  batches: number;
  inputCharacters: number;
  duplicateCandidates: number;
  cacheHits: number;
  maskApplyMs: number;
}
interface TextGroup { text: string; candidates: TextCandidate[] }
interface CachedDecision { expiresAt: number; match: Match | null }
const MAX_CACHED_DECISIONS = 700;
const CACHE_TTL_MS = 60_000;

// Content scripts collect candidates; the supported extension Window owns inference.
export class AiClassifier {
  #client = new NativeAiClient();
  #decisions = new Map<string, CachedDecision>();
  #scope = "";
  #generation = 0;
  #cacheTimer: ReturnType<typeof setTimeout> | undefined;
  #rules: BlockingRule[] = [];

  constructor(private priority?: Priority, private diagnostics?: (value: ClassifierDiagnostics) => void) {}

  get cachedDecisionCount(): number { return this.#decisions.size; }

  async text(candidates: TextCandidate[], settings: Settings, memory: SpoilerMemory,
    onMatch: (candidate: TextCandidate, match: Match) => void, isCurrent: () => boolean,
    onBatch?: () => Promise<void>, onBusy?: (candidates: TextCandidate[]) => void,
    collectMore?: (limit: number) => TextCandidate[]): Promise<void> {
    this.#enterScope(settings, memory);
    if (!settings.useLocalAI) return;
    const generation = this.#generation;
    const current = () => generation === this.#generation && isCurrent();
    const groups = new Map<string, TextGroup>();
    const seen = new WeakMap<Text, string>();
    const metrics: ClassifierDiagnostics = { batches: 0, inputCharacters: 0, duplicateCandidates: 0, cacheHits: 0, maskApplyMs: 0 };
    const apply = (candidate: TextCandidate, match: Match) => {
      if (!current() || !unchanged(candidate)) return;
      const start = performance.now(); onMatch(candidate, relabelMatch(match, this.#rules)); metrics.maskApplyMs += performance.now() - start;
    };
    const add = (items: TextCandidate[]) => {
      for (const candidate of items) {
        if (!current() || !unchanged(candidate) || seen.get(candidate.node) === candidate.text) continue;
        seen.set(candidate.node, candidate.text);
        const cached = this.#cached(candidate.text);
        if (cached) { metrics.cacheHits += 1; if (cached.match) apply(candidate, cached.match); continue; }
        const group = groups.get(candidate.text);
        if (group) { group.candidates.push(candidate); metrics.duplicateCandidates += 1; }
        else groups.set(candidate.text, { text: candidate.text, candidates: [candidate] });
      }
    };
    try {
      add(candidates);
      while (current()) {
        // Keep the live queue small enough to admit a new visible mutation between
        // batches, rather than waiting behind a whole page's original snapshot.
        if (collectMore && groups.size < MAX_TEXT_BATCH * 2) add(collectMore(MAX_TEXT_BATCH * 2 - groups.size));
        const pending = [...groups.values()].filter((group) => group.candidates.some(unchanged));
        if (!pending.length) return;
        // Every fourth batch is FIFO. Scrolling or new visible content can move
        // ahead without indefinitely starving an older offscreen candidate.
        if (metrics.batches % 4 !== 3) pending.sort((left, right) => Number(groupInViewport(right)) - Number(groupInViewport(left)));
        const batch = pending.slice(0, MAX_TEXT_BATCH);
        const texts = batch.map(({ text }) => text.slice(0, MAX_TEXT_LENGTH));
        const response = await this.#client.request({ kind: "text", texts }, current,
          this.#priority(batch.some(groupInViewport)));
        metrics.batches += 1; metrics.inputCharacters += texts.reduce((total, text) => total + text.length, 0);
        if (!current()) return;
        if (!response.ok && response.reason === "busy") onBusy?.([...groups.values()].flatMap((group) => group.candidates));
        if (!response.ok || !("decisions" in response)) return;
        const decisions = new Map(response.decisions.map((decision) => [decision.i, decision]));
        for (const [index, group] of batch.entries()) {
          if (!current()) return;
          const decision = decisions.get(index);
          const match = decision?.block ? relabelMatch({ ruleId: decision.ruleId || "local-ai", ruleName: decision.rule || "On-device match",
            reason: decision.reason || "on-device semantic match" }, this.#rules) : null;
          // A successful sparse-positive response also establishes exact negatives.
          // Prefix-only inputs are never admitted as decisions for the full text.
          if (group.text.length <= MAX_TEXT_LENGTH) this.#remember(group.text, match);
          if (match) for (const candidate of group.candidates) apply(candidate, match);
          groups.delete(group.text);
        }
        if (onBatch && current()) await onBatch();
      }
    } finally {
      try { this.diagnostics?.(metrics); } catch { /* Diagnostics cannot interrupt protection. */ }
    }
  }

  async images(candidates: ImageCandidate[], settings: Settings, memory: SpoilerMemory,
    onMatch: (candidate: ImageCandidate, match: Match) => void, isCurrent: () => boolean,
    onBusy?: (candidates: ImageCandidate[]) => void): Promise<void> {
    this.#enterScope(settings, memory);
    const generation = this.#generation;
    const current = () => generation === this.#generation && isCurrent();
    if (!settings.useLocalAI || !settings.useVision || !await this.visionAvailable(current, () => onBusy?.(candidates)) || !current()) return;
    const pending = [...candidates];
    let completed = 0;
    while (pending.length) {
      if (!current()) return;
      const visibleIndex = completed % 4 === 3 ? -1 : pending.findIndex(({ element }) => inViewport(element));
      const candidate = pending.splice(Math.max(0, visibleIndex), 1)[0]!;
      if (!candidate.element.isConnected) continue;
      try {
        const input = await promptImageInput(candidate.element);
        const dataUrl = input ? await imageDataUrl(input) : null;
        if (dataUrl && current() && await this.#image(candidate, dataUrl, onMatch, current)) {
          onBusy?.([candidate, ...pending]);
          return;
        }
      } catch { /* Description matching remains active for unreadable image pixels. */ }
      completed += 1;
    }
  }

  async prefetchedImages(inputs: Array<{ candidate: ImageCandidate; blob: Blob }>, settings: Settings, memory: SpoilerMemory,
    onMatch: (candidate: ImageCandidate, match: Match) => void, isCurrent: () => boolean): Promise<void> {
    this.#enterScope(settings, memory);
    const generation = this.#generation;
    const current = () => generation === this.#generation && isCurrent();
    if (!settings.useLocalAI || !settings.useVision) return;
    for (const { candidate, blob } of inputs.slice(0, 3)) {
      if (!current()) return;
      try {
        const dataUrl = await imageDataUrl(blob);
        if (dataUrl && current()) await this.#image(candidate, dataUrl, onMatch, current);
      } catch { /* Optional speculation never blocks normal scanning. */ }
    }
  }

  async visionAvailable(isCurrent?: () => boolean, onBusy?: () => void): Promise<boolean> {
    const response = await this.#client.request({ kind: "capabilities" }, isCurrent, this.#priority(false));
    if (!response.ok && response.reason === "busy") onBusy?.();
    return response.ok && "image" in response && response.image;
  }

  async reset(): Promise<void> {
    this.#generation += 1; this.#scope = ""; this.#clearDecisions(); this.#client.reset();
  }

  relabel(rules: BlockingRule[]): void {
    this.#rules = rules;
    for (const value of this.#decisions.values()) if (value.match) value.match = relabelMatch(value.match, rules);
  }

  #enterScope(settings: Settings, memory: SpoilerMemory): void {
    const scope = JSON.stringify({ url: location.href, settings: criteriaSettings(settings), memory: matchingMemorySignature(memory, settings.rules) });
    this.relabel(settings.rules);
    if (scope === this.#scope) return;
    this.#generation += 1; this.#scope = scope; this.#clearDecisions(); this.#client.reset();
  }

  #cached(text: string): CachedDecision | undefined {
    const cached = this.#decisions.get(text);
    if (cached && cached.expiresAt > Date.now()) return cached;
    if (cached) this.#decisions.delete(text);
    return undefined;
  }

  #remember(text: string, match: Match | null): void {
    this.#purgeDecisions();
    this.#decisions.delete(text);
    while (this.#decisions.size >= MAX_CACHED_DECISIONS) this.#decisions.delete(this.#decisions.keys().next().value!);
    this.#decisions.set(text, { expiresAt: Date.now() + CACHE_TTL_MS, match });
    this.#scheduleCacheExpiry();
  }

  #purgeDecisions(): void {
    const now = Date.now();
    for (const [text, value] of this.#decisions) if (value.expiresAt <= now) this.#decisions.delete(text);
  }

  #scheduleCacheExpiry(): void {
    clearTimeout(this.#cacheTimer); this.#cacheTimer = undefined;
    if (!this.#decisions.size) return;
    const expiresAt = Math.min(...[...this.#decisions.values()].map((value) => value.expiresAt));
    this.#cacheTimer = setTimeout(() => {
      this.#cacheTimer = undefined; this.#purgeDecisions(); this.#scheduleCacheExpiry();
    }, Math.max(0, expiresAt - Date.now()));
  }

  #clearDecisions(): void {
    clearTimeout(this.#cacheTimer); this.#cacheTimer = undefined; this.#decisions.clear();
  }

  #priority(viewport: boolean): Priority {
    return this.priority ?? (document.visibilityState === "visible" && viewport ? "foreground" : "background");
  }

  async #image(candidate: ImageCandidate, dataUrl: string,
    onMatch: (candidate: ImageCandidate, match: Match) => void, isCurrent: () => boolean): Promise<boolean> {
    const response = await this.#client.request({ kind: "image", metadata: candidate.metadataText.slice(0, 1000), dataUrl }, isCurrent,
      this.#priority(inViewport(candidate.element)));
    if (isCurrent() && response.ok && "decision" in response && response.decision?.block) onMatch(candidate, relabelMatch({
      ruleId: response.decision.ruleId || "local-ai-image", ruleName: response.decision.rule || "On-device image match",
      reason: response.decision.reason || "on-device image match",
    }, this.#rules));
    return !response.ok && response.reason === "busy";
  }
}

function unchanged(candidate: TextCandidate): boolean {
  return Boolean(candidate.node.parentNode && candidate.text && normalizeWhitespace(candidate.node.data) === candidate.text);
}

function groupInViewport(group: TextGroup): boolean {
  return group.candidates.some((candidate) => unchanged(candidate) && inViewport(candidate.node.parentElement));
}

async function imageDataUrl(input: Element | Blob): Promise<string | null> {
  if (input instanceof Blob) {
    if (input.size > MAX_IMAGE_BYTES || !/^image\/(?:png|jpeg|webp|gif|avif)$/.test(input.type)) return null;
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(input);
    });
  }
  let width: number, height: number;
  if (input instanceof HTMLImageElement) {
    if (!input.complete) return null;
    width = input.naturalWidth;
    height = input.naturalHeight;
  } else if (input instanceof HTMLCanvasElement) {
    width = input.width;
    height = input.height;
  } else return null;
  if (!width || !height) return null;
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 1024 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(input, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ? imageDataUrl(blob) : null), "image/jpeg", .85);
  });
}
