import { browser } from "wxt/browser";
import {
  buildGoogleNewsRssUrl,
  buildRuleSearchQuery,
  DEFAULT_MEMORY,
  extractRssItems,
  mergeMemory,
  normalizeMemory,
  summarizeMemory,
} from "../core/memory";
import { MEMORY_KEY } from "../core/status";
import type { MemoryRuleRun, MemorySummary, SpoilerMemory } from "../core/types";
import { loadSettings, updateStatus } from "../platform/storage";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_IMAGE_BYTES = 1_500_000;

export async function loadMemory(): Promise<SpoilerMemory> {
  const result = await browser.storage.local.get(MEMORY_KEY);
  return normalizeMemory(result[MEMORY_KEY] as Partial<SpoilerMemory> | undefined);
}

export async function refreshSpoilerMemory(reason: "manual" | "alarm"): Promise<MemorySummary> {
  const settings = await loadSettings();
  if (!settings.memoryEnabled) return summarizeMemory({ ...await loadMemory(), enabled: false });
  const current = await loadMemory();
  const discoveredAt = new Date().toISOString();
  const entries = [];
  const imageExamples = [];
  const ruleRuns: Record<string, MemoryRuleRun> = {};
  const errors: string[] = [];

  for (const rule of settings.rules.filter((item) => item.enabled)) {
    try {
      const response = await fetchWithTimeout(buildGoogleNewsRssUrl(rule), { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error(`Public search returned ${response.status}.`);
      const extracted = extractRssItems(await response.text(), rule, discoveredAt);
      entries.push(...extracted.entries);
      imageExamples.push(...extracted.imageExamples);
      ruleRuns[rule.id] = {
        at: discoveredAt,
        reason,
        query: buildRuleSearchQuery(rule),
        resultCount: extracted.entries.length,
        imageExampleCount: extracted.imageExamples.length,
      };
    } catch (error) {
      errors.push(`${rule.name}: ${formatError(error)}`);
    }
  }

  const merged = mergeMemory(current, {
    enabled: true,
    entries,
    imageExamples,
    ruleRuns,
    lastUpdatedAt: discoveredAt,
    lastError: errors.join("; "),
  }, {
    maxEntriesPerRule: settings.memoryMaxEntriesPerRule,
    maxImageExamplesPerRule: settings.memoryMaxImageExamplesPerRule,
  });
  await browser.storage.local.set({ [MEMORY_KEY]: merged });
  const summary = summarizeMemory(merged);
  await updateStatus({ memory: summary });
  return summary;
}

export async function clearMemory(): Promise<void> {
  await browser.storage.local.set({ [MEMORY_KEY]: DEFAULT_MEMORY });
  await updateStatus({ memory: summarizeMemory(DEFAULT_MEMORY) });
}

export async function fetchImageDataUrl(url: string): Promise<{ dataUrl: string; contentType: string; bytes: number }> {
  if (/^data:/i.test(url)) return { dataUrl: url, contentType: parseDataUrlType(url), bytes: Math.ceil(url.length * .75) };
  if (!/^https?:\/\//i.test(url)) throw new Error("Unsupported image address.");
  const response = await fetchWithTimeout(url, { credentials: "omit", cache: "force-cache" });
  if (!response.ok) throw new Error(`Image request returned ${response.status}.`);
  const contentType = response.headers.get("content-type") || "image/png";
  if (!contentType.startsWith("image/")) throw new Error("The address did not return an image.");
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("The image is too large for on-device analysis.");
  return { dataUrl: `data:${contentType};base64,${arrayBufferToBase64(buffer)}`, contentType, bytes: buffer.byteLength };
}

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function parseDataUrlType(url: string): string {
  return url.match(/^data:([^;,]+)/i)?.[1] ?? "image/png";
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
