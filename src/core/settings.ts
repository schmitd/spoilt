import type { BlockingRule, RedactionStyle, Settings, Strictness } from "./types";

export const SETTINGS_KEY = "spoilt.settings";

export const DEFAULT_RULE: BlockingRule = {
  id: "plot-spoilers",
  name: "Plot spoilers",
  description: "Story endings, deaths, reveals, twists, episode recaps, leaks, and major plot outcomes.",
  keywords: ["spoiler", "ending", "dies", "death", "killed", "twist", "finale", "post-credit", "leak"],
  enabled: true,
};

export const DEFAULT_SETTINGS: Settings = {
  version: 2,
  enabled: true,
  useLocalAI: true,
  useVision: true,
  scanText: true,
  scanImages: true,
  memoryEnabled: true,
  memoryRefreshHours: 12,
  memoryMaxEntriesPerRule: 16,
  memoryMaxImageExamplesPerRule: 8,
  strictness: "balanced",
  redactionStyle: "whiteout",
  maxTextNodesPerScan: 700,
  maxImagesPerScan: 80,
  rules: [DEFAULT_RULE],
};

export function createRule(index = 0): BlockingRule {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    keywords: [],
    enabled: true,
  };
}

export function normalizeSettings(value: unknown): Settings {
  const input = isRecord(value) ? value : {};
  const rules = Array.isArray(input.rules)
    ? input.rules.map(normalizeRule).filter((rule): rule is BlockingRule => rule !== null)
    : [];

  return {
    ...DEFAULT_SETTINGS,
    version: 2,
    enabled: booleanValue(input.enabled, DEFAULT_SETTINGS.enabled),
    useLocalAI: booleanValue(input.useLocalAI, DEFAULT_SETTINGS.useLocalAI),
    useVision: booleanValue(input.useVision, DEFAULT_SETTINGS.useVision),
    scanText: booleanValue(input.scanText, DEFAULT_SETTINGS.scanText),
    scanImages: booleanValue(input.scanImages, DEFAULT_SETTINGS.scanImages),
    memoryEnabled: booleanValue(input.memoryEnabled, DEFAULT_SETTINGS.memoryEnabled),
    memoryRefreshHours: clampNumber(input.memoryRefreshHours, 1, 168, 12),
    memoryMaxEntriesPerRule: clampNumber(input.memoryMaxEntriesPerRule, 4, 80, 16),
    memoryMaxImageExamplesPerRule: clampNumber(input.memoryMaxImageExamplesPerRule, 2, 40, 8),
    strictness: strictnessValue(input.strictness),
    redactionStyle: redactionStyleValue(input.redactionStyle),
    maxTextNodesPerScan: clampNumber(input.maxTextNodesPerScan, 50, 3000, 700),
    maxImagesPerScan: clampNumber(input.maxImagesPerScan, 10, 500, 80),
    rules: Array.isArray(input.rules) ? rules : [DEFAULT_RULE],
  };
}

export function parseKeywordInput(value: string): string[] {
  return Array.from(new Set(value
    .split(/[\s,;]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean)));
}

function normalizeRule(value: unknown, index: number): BlockingRule | null {
  if (!isRecord(value)) return null;
  const keywords = Array.isArray(value.keywords)
    ? value.keywords.map(String).map((keyword) => keyword.trim()).filter(Boolean)
    : [];
  const name = String(value.name ?? "").trim();
  const description = String(value.description ?? "").trim();
  if (!name && !description && keywords.length === 0) return null;
  return {
    id: String(value.id || `rule-${index}`),
    name: name || `Rule ${index + 1}`,
    description,
    keywords,
    enabled: booleanValue(value.enabled, true),
  };
}

function strictnessValue(value: unknown): Strictness {
  return value === "loose" || value === "strict" || value === "balanced" ? value : "balanced";
}

function redactionStyleValue(value: unknown): RedactionStyle {
  if (value === "marker" || value === "whiteout") return value;
  return DEFAULT_SETTINGS.redactionStyle;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
