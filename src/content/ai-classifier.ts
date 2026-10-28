import type { Match, Settings, SpoilerMemory } from "../core/types";
import { MAX_IMAGE_BYTES, MAX_TEXT_BATCH, MAX_TEXT_LENGTH } from "../core/native-ai-protocol";
import { NativeAiClient } from "../platform/native-ai-client";
import { promptImageInput, type ImageCandidate, type TextCandidate } from "./dom";

// Content scripts collect candidates; the supported extension Window owns inference.
export class AiClassifier {
  #client = new NativeAiClient();

  async text(candidates: TextCandidate[], settings: Settings, _memory: SpoilerMemory,
    onMatch: (candidate: TextCandidate, match: Match) => void, isCurrent: () => boolean,
    onBatch?: () => Promise<void>, onBusy?: (candidates: TextCandidate[]) => void): Promise<void> {
    if (!settings.useLocalAI) return;
    for (let index = 0; index < candidates.length; index += MAX_TEXT_BATCH) {
      if (!isCurrent()) return;
      const batch = candidates.slice(index, index + MAX_TEXT_BATCH).filter((candidate) => candidate.node.parentNode && candidate.text);
      if (!batch.length) continue;
      const response = await this.#client.request({ kind: "text", texts: batch.map(({ text }) => text.slice(0, MAX_TEXT_LENGTH)) }, isCurrent);
      if (!isCurrent()) return;
      if (!response.ok && response.reason === "busy") onBusy?.(candidates.slice(index));
      if (!response.ok || !("decisions" in response)) return;
      for (const decision of response.decisions) {
        const candidate = batch[decision.i];
        if (candidate && decision.block && candidate.node.parentNode) onMatch(candidate, {
          ruleId: "local-ai", ruleName: decision.rule || "On-device match", reason: decision.reason || "on-device semantic match",
        });
      }
      if (onBatch && isCurrent()) await onBatch();
    }
  }

  async images(candidates: ImageCandidate[], settings: Settings, _memory: SpoilerMemory,
    onMatch: (candidate: ImageCandidate, match: Match) => void, isCurrent: () => boolean,
    onBusy?: (candidates: ImageCandidate[]) => void): Promise<void> {
    if (!settings.useLocalAI || !settings.useVision || !await this.visionAvailable(isCurrent, () => onBusy?.(candidates)) || !isCurrent()) return;
    for (const [index, candidate] of candidates.slice(0, 12).entries()) {
      if (!isCurrent() || !candidate.element.isConnected) return;
      try {
        const input = await promptImageInput(candidate.element);
        const dataUrl = input ? await imageDataUrl(input) : null;
        if (dataUrl && isCurrent() && await this.#image(candidate, dataUrl, onMatch, isCurrent)) {
          onBusy?.(candidates.slice(index));
          return;
        }
      } catch { /* Description matching remains active for unreadable image pixels. */ }
    }
  }

  async prefetchedImages(inputs: Array<{ candidate: ImageCandidate; blob: Blob }>, settings: Settings, _memory: SpoilerMemory,
    onMatch: (candidate: ImageCandidate, match: Match) => void, isCurrent: () => boolean): Promise<void> {
    if (!settings.useLocalAI || !settings.useVision) return;
    for (const { candidate, blob } of inputs.slice(0, 3)) {
      if (!isCurrent()) return;
      try {
        const dataUrl = await imageDataUrl(blob);
        if (dataUrl && isCurrent()) await this.#image(candidate, dataUrl, onMatch, isCurrent);
      } catch { /* Optional speculation never blocks normal scanning. */ }
    }
  }

  async visionAvailable(isCurrent?: () => boolean, onBusy?: () => void): Promise<boolean> {
    const response = await this.#client.request({ kind: "capabilities" }, isCurrent);
    if (!response.ok && response.reason === "busy") onBusy?.();
    return response.ok && "image" in response && response.image;
  }

  async reset(): Promise<void> { this.#client.reset(); }

  async #image(candidate: ImageCandidate, dataUrl: string,
    onMatch: (candidate: ImageCandidate, match: Match) => void, isCurrent: () => boolean): Promise<boolean> {
    const response = await this.#client.request({ kind: "image", metadata: candidate.metadataText.slice(0, 1000), dataUrl }, isCurrent);
    if (isCurrent() && response.ok && "decision" in response && response.decision?.block) onMatch(candidate, {
      ruleId: "local-ai-image", ruleName: response.decision.rule || "On-device image match",
      reason: response.decision.reason || "on-device image match",
    });
    return !response.ok && response.reason === "busy";
  }
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
