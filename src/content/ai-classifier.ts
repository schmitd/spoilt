import { buildMemoryContext } from "../core/memory";
import { buildRulesSummary, strictnessGuidance } from "../core/matching";
import { parseModelJson } from "../core/model-json";
import { SerialQueue } from "../core/serial-queue";
import type { Match, Settings, SpoilerMemory } from "../core/types";
import { withAiLease } from "../platform/ai-lease";
import { updateStatus } from "../platform/storage";
import { promptImageInput, type ImageCandidate, type TextCandidate } from "./dom";

interface TextDecision {
  i: number;
  block: boolean;
  rule?: string;
  reason?: string;
}

interface ImageDecision {
  block: boolean;
  rule?: string;
  reason?: string;
}

export class AiClassifier {
  #textSession: Promise<LanguageModelSession | null> | null = null;
  #imageSession: Promise<LanguageModelSession | null> | null = null;
  #textQueue = new SerialQueue();
  #imageQueue = new SerialQueue();

  async text(
    candidates: TextCandidate[],
    settings: Settings,
    memory: SpoilerMemory,
    onMatch: (candidate: TextCandidate, match: Match) => void,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!settings.useLocalAI || typeof LanguageModel === "undefined") {
      await updateStatus({ aiText: "unavailable", aiReason: "Keyword protection is active. On-device analysis is unavailable.", lastError: "" });
      return;
    }
    try {
      await withAiLease("text", async () => {
        try {
          for (let index = 0; index < candidates.length; index += 18) {
            if (!isCurrent()) return;
            const batch = candidates.slice(index, index + 18).filter((candidate) => candidate.node.parentNode);
            if (!batch.length) continue;
            const decisions = await this.#classifyTextBatch(batch, settings, memory, isCurrent);
            for (const decision of decisions) {
              const candidate = batch[decision.i];
              if (candidate && decision.block && candidate.node.parentNode) {
                onMatch(candidate, {
                  ruleId: "local-ai",
                  ruleName: decision.rule || "On-device match",
                  reason: decision.reason || "on-device semantic match",
                });
              }
            }
          }
        } finally {
          await this.#resetText();
        }
      });
    } catch (error) {
      await this.#recordLeaseFailure("text", error);
    }
  }

  async images(
    candidates: ImageCandidate[],
    settings: Settings,
    memory: SpoilerMemory,
    onMatch: (candidate: ImageCandidate, match: Match) => void,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!settings.useVision || typeof LanguageModel === "undefined") {
      await updateStatus({ aiVision: "fallback", lastError: "" });
      return;
    }
    try {
      await withAiLease("image", async () => {
        try {
          for (const candidate of candidates.slice(0, 12)) {
            if (!isCurrent() || !candidate.element.isConnected) return;
            const decision = await this.#classifyImage(candidate, settings, memory, isCurrent);
            if (decision?.block) {
              onMatch(candidate, {
                ruleId: "local-ai-image",
                ruleName: decision.rule || "On-device image match",
                reason: decision.reason || "on-device image match",
              });
            }
          }
        } finally {
          await this.#resetImage();
        }
      });
    } catch (error) {
      await this.#recordLeaseFailure("image", error);
    }
  }

  async reset(): Promise<void> {
    await Promise.all([this.#resetText(), this.#resetImage()]);
  }

  async #classifyTextBatch(
    batch: TextCandidate[],
    settings: Settings,
    memory: SpoilerMemory,
    isCurrent: () => boolean,
  ): Promise<TextDecision[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!isCurrent()) return [];
      const session = await this.#getTextSession(settings);
      if (!session) return [];
      try {
        const decisions = await this.#textQueue.run(async () => {
          if (!isCurrent()) return [];
          return this.#promptText(session, batch, settings, memory);
        });
        if (attempt > 0) {
          await updateStatus({ aiText: "available", aiReason: "On-device text analysis recovered.", lastError: "" });
        }
        return decisions;
      } catch (error) {
        if (!isRecoverableSessionError(error)) {
          await updateStatus({ lastError: `Text analysis needs attention: ${formatError(error)}` });
          return [];
        }
        await updateStatus({
          aiText: "recovering",
          aiReason: "On-device text analysis was interrupted. Waiting requests are queued while it reconnects.",
          lastError: "",
        });
        await this.#resetText();
      }
    }
    await updateStatus({
      aiText: "fallback",
      aiReason: "Text analysis was interrupted. Keyword and rule matching remain active; Spoilt will retry automatically.",
      lastError: "",
    });
    return [];
  }

  async #classifyImage(
    candidate: ImageCandidate,
    settings: Settings,
    memory: SpoilerMemory,
    isCurrent: () => boolean,
  ): Promise<ImageDecision | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!isCurrent() || !candidate.element.isConnected) return null;
      const session = await this.#getImageSession(settings);
      if (!session) return null;
      try {
        const decision = await this.#imageQueue.run(async () => {
          if (!isCurrent() || !candidate.element.isConnected) return null;
          const input = await promptImageInput(candidate.element);
          if (!input) return null;
          const result = await session.prompt([{
            role: "user",
            content: [
              { type: "text", value: this.#imagePrompt(candidate, settings, memory) },
              { type: "image", value: input },
            ],
          }], { responseConstraint: imageConstraint });
          return parseModelJson<ImageDecision>(result);
        });
        if (attempt > 0) {
          await updateStatus({ aiVision: "available", aiReason: "On-device image analysis recovered.", lastError: "" });
        }
        return decision;
      } catch (error) {
        if (!isRecoverableSessionError(error)) {
          await updateStatus({
            aiVision: "metadata fallback",
            aiReason: "Image protection is using descriptions while on-device image analysis recovers.",
          });
          return null;
        }
        await updateStatus({
          aiVision: "recovering",
          aiReason: "On-device image analysis was interrupted. Waiting requests are queued while it reconnects.",
          lastError: "",
        });
        await this.#resetImage();
      }
    }
    await updateStatus({
      aiVision: "metadata fallback",
      aiReason: "Image analysis was interrupted. Description matching remains active; Spoilt will retry automatically.",
      lastError: "",
    });
    return null;
  }

  async #promptText(session: LanguageModelSession, batch: TextCandidate[], settings: Settings, memory: SpoilerMemory): Promise<TextDecision[]> {
    const payload = batch.map((candidate, i) => ({ i, text: candidate.text.slice(0, 600) }));
    const result = await session.prompt(
      `User boundaries:\n${buildRulesSummary(settings.rules)}\n\nRecent public context:\n${memorySummary(settings, memory) || "None."}\n\nStrictness: ${strictnessGuidance(settings.strictness)}\n\nReturn only JSON {"decisions":[{"i":0,"block":false,"rule":"","reason":""}]}. Snippets:\n${JSON.stringify(payload)}`,
      { responseConstraint: textConstraint },
    );
    return parseModelJson<{ decisions?: TextDecision[] }>(result).decisions ?? [];
  }

  #imagePrompt(candidate: ImageCandidate, settings: Settings, memory: SpoilerMemory): string {
    return `User boundaries:\n${buildRulesSummary(settings.rules)}\n\nRecent public context:\n${memorySummary(settings, memory) || "None."}\n\nStrictness: ${strictnessGuidance(settings.strictness)}\n\nImage description and nearby text: ${candidate.metadataText || "none"}\n\nReturn only JSON {"block":boolean,"rule":"","reason":""}.`;
  }

  async #getTextSession(settings: Settings): Promise<LanguageModelSession | null> {
    if (!settings.useLocalAI || typeof LanguageModel === "undefined") {
      await updateStatus({ aiText: "unavailable", aiReason: "Keyword protection is active. On-device analysis is unavailable." });
      return null;
    }
    if (this.#textSession) return this.#textSession;
    const pending = this.#textQueue.run(() => createSession("text")).catch(async (error) => {
      if (this.#textSession === pending) this.#textSession = null;
      await updateStatus(isRecoverableSessionError(error)
        ? { aiText: "recovering", aiReason: "On-device text analysis will retry automatically.", lastError: "" }
        : { aiText: "unavailable", lastError: formatError(error) });
      return null;
    });
    this.#textSession = pending;
    return pending;
  }

  async #getImageSession(settings: Settings): Promise<LanguageModelSession | null> {
    if (!settings.useVision || typeof LanguageModel === "undefined") {
      await updateStatus({ aiVision: "fallback" });
      return null;
    }
    if (this.#imageSession) return this.#imageSession;
    const pending = this.#imageQueue.run(() => createSession("image")).catch(async (error) => {
      if (this.#imageSession === pending) this.#imageSession = null;
      await updateStatus(isRecoverableSessionError(error)
        ? { aiVision: "recovering", aiReason: "On-device image analysis will retry automatically.", lastError: "" }
        : { aiVision: "fallback", lastError: formatError(error) });
      return null;
    });
    this.#imageSession = pending;
    return pending;
  }

  async #resetText(): Promise<void> {
    const old = this.#textSession;
    this.#textSession = null;
    await this.#textQueue.run(async () => {
      const session = await old?.catch(() => null);
      session?.destroy();
    });
  }

  async #resetImage(): Promise<void> {
    const old = this.#imageSession;
    this.#imageSession = null;
    await this.#imageQueue.run(async () => {
      const session = await old?.catch(() => null);
      session?.destroy();
    });
  }

  async #recordLeaseFailure(kind: "text" | "image", error: unknown): Promise<void> {
    if (isRecoverableSessionError(error)) {
      await updateStatus({
        [kind === "text" ? "aiText" : "aiVision"]: kind === "text" ? "recovering" : "metadata fallback",
        aiReason: kind === "text"
          ? "On-device text analysis is busy. Keyword and rule matching remain active while Spoilt retries."
          : "On-device image analysis is busy. Description matching remains active while Spoilt retries.",
        lastError: "",
      });
      return;
    }
    await updateStatus({
      [kind === "text" ? "aiText" : "aiVision"]: kind === "text" ? "fallback" : "metadata fallback",
      aiReason: `${kind === "text" ? "Text" : "Image"} analysis is temporarily unavailable. ${formatError(error)}`,
      lastError: "",
    });
  }
}

async function createSession(kind: "text" | "image"): Promise<LanguageModelSession | null> {
  const options: LanguageModelCreateOptions = {
    expectedInputs: kind === "image"
      ? [{ type: "text", languages: ["en"] }, { type: "image" }]
      : [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
    initialPrompts: [{ role: "system", content: "Classify only against the user's boundaries. Prefer false when uncertain." }],
  };
  const availability = await LanguageModel!.availability(options);
  const statusKey = kind === "text" ? "aiText" : "aiVision";
  if (availability !== "available") {
    await updateStatus({
      [statusKey]: availability === "unavailable" ? (kind === "image" ? "fallback" : "unavailable") : availability,
      aiReason: "Use Prepare on-device analysis in Spoilt when Chrome is ready to download the model.",
    });
    return null;
  }
  const session = await LanguageModel!.create(options);
  await updateStatus({ [statusKey]: "available", aiReason: "On-device analysis is ready." });
  return session;
}

function memorySummary(settings: Settings, memory: SpoilerMemory): string {
  return settings.rules.map((rule) => {
    const context = buildMemoryContext(memory, rule.id, 5);
    return context ? `${rule.name}:\n${context}` : "";
  }).filter(Boolean).join("\n");
}

function isRecoverableSessionError(error: unknown): boolean {
  const text = formatError(error).toLowerCase();
  return text.includes("aborterror")
    || text.includes("request was cancelled")
    || text.includes("unable to create a session")
    || text.includes("timed out waiting for on-device analysis")
    || (text.includes("invalidstateerror") && (text.includes("destroyed") || text.includes("session")));
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const textConstraint = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "number" },
          block: { type: "boolean" },
          rule: { type: "string" },
          reason: { type: "string" },
        },
        required: ["i", "block"],
      },
    },
  },
  required: ["decisions"],
};

const imageConstraint = {
  type: "object",
  properties: {
    block: { type: "boolean" },
    rule: { type: "string" },
    reason: { type: "string" },
  },
  required: ["block"],
};
