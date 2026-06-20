import type { ExtensionStatus, MemorySummary, ScanCounters } from "./types";

export const STATUS_KEY = "spoilt.status";
export const MEMORY_KEY = "spoilt.memory";

export const EMPTY_COUNTERS: ScanCounters = { text: 0, images: 0, aiText: 0, aiImages: 0 };

export const EMPTY_MEMORY_SUMMARY: MemorySummary = {
  enabled: true,
  lastUpdatedAt: "",
  lastError: "",
  entryCount: 0,
  imageExampleCount: 0,
  ruleRuns: {},
};

export const EMPTY_STATUS: ExtensionStatus = {
  enabled: true,
  counters: EMPTY_COUNTERS,
  aiText: "unknown",
  aiVision: "unknown",
  aiReason: "",
  lastError: "",
  lastScanAt: "",
  pendingText: 0,
  pendingImages: 0,
  updatedAt: "",
  memory: EMPTY_MEMORY_SUMMARY,
};

export function normalizeStatus(value: unknown): ExtensionStatus {
  const input = isRecord(value) ? value : {};
  const counters = isRecord(input.counters) ? input.counters : {};
  const memory = isRecord(input.memory) ? input.memory : {};
  const lastError = transientCancellation(input.lastError) ? "" : String(input.lastError ?? "");
  return {
    ...EMPTY_STATUS,
    ...input,
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
    counters: {
      text: numberValue(counters.text),
      images: numberValue(counters.images),
      aiText: numberValue(counters.aiText),
      aiImages: numberValue(counters.aiImages),
    },
    memory: {
      ...EMPTY_MEMORY_SUMMARY,
      ...memory,
      enabled: typeof memory.enabled === "boolean" ? memory.enabled : true,
      entryCount: numberValue(memory.entryCount),
      imageExampleCount: numberValue(memory.imageExampleCount),
      ruleRuns: isRecord(memory.ruleRuns) ? memory.ruleRuns as MemorySummary["ruleRuns"] : {},
    },
    lastError,
  } as ExtensionStatus;
}

function transientCancellation(value: unknown): boolean {
  const text = String(value ?? "").toLocaleLowerCase();
  return text.includes("aborterror") || text.includes("request was cancelled");
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
