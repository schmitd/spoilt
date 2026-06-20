import { normalizeComparableText } from "./matching";
import type {
  BlockingRule,
  Match,
  MemoryEntry,
  MemoryImageExample,
  MemorySummary,
  SpoilerMemory,
} from "./types";

export const DEFAULT_MEMORY: SpoilerMemory = {
  version: 1,
  enabled: true,
  lastUpdatedAt: "",
  lastError: "",
  entries: [],
  imageExamples: [],
  ruleRuns: {},
};

const STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "before", "block", "but", "can", "content", "details",
  "does", "from", "have", "into", "just", "latest", "major", "more", "news", "not", "official",
  "other", "over", "reveals", "should", "show", "spoiler", "spoilers", "that", "the", "their", "them",
  "then", "there", "these", "this", "those", "through", "update", "when", "where", "with", "what",
  "will", "would", "your",
]);

export function normalizeMemory(value?: Partial<SpoilerMemory> | null): SpoilerMemory {
  return {
    ...DEFAULT_MEMORY,
    ...(value ?? {}),
    entries: Array.isArray(value?.entries) ? value.entries : [],
    imageExamples: Array.isArray(value?.imageExamples) ? value.imageExamples : [],
    ruleRuns: value?.ruleRuns && typeof value.ruleRuns === "object" ? value.ruleRuns : {},
  };
}

export function buildRuleSearchQuery(rule: BlockingRule): string {
  const pieces = [rule.name, rule.description, ...rule.keywords.slice(0, 8)].filter(Boolean).join(" ");
  const terms = significantTerms(pieces, 12);
  return terms.length ? terms.join(" ") : rule.name || "spoiler";
}

export function buildGoogleNewsRssUrl(rule: BlockingRule): string {
  const query = `${buildRuleSearchQuery(rule)} spoiler OR leak OR ending OR reveal`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

export function extractRssItems(xml: string, rule: BlockingRule, discoveredAt: string): {
  entries: MemoryEntry[];
  imageExamples: MemoryImageExample[];
} {
  const entries: MemoryEntry[] = [];
  const imageExamples: MemoryImageExample[] = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  for (const block of blocks.slice(0, 12)) {
    const title = cleanText(readTag(block, "title"));
    const rawDescription = readTag(block, "description");
    const snippet = cleanText(stripTags(rawDescription));
    const url = cleanText(readTag(block, "link"));
    const source = cleanText(readTag(block, "source"));
    const publishedAt = cleanText(readTag(block, "pubDate"));
    if (!title && !snippet) continue;
    const terms = significantTerms(`${title} ${snippet}`, 10);
    entries.push({
      id: stableId(`${rule.id}|${title}|${url}`),
      ruleId: rule.id,
      title,
      snippet,
      url,
      source,
      publishedAt,
      discoveredAt,
      terms,
      reason: `Recent public result for ${rule.name || "configured boundary"}`,
    });
    for (const imageUrl of extractImageUrls(block, rawDescription).slice(0, 2)) {
      imageExamples.push({
        id: stableId(`${rule.id}|${imageUrl}|${title}`),
        ruleId: rule.id,
        imageUrl,
        sourceUrl: url,
        title,
        label: rule.name || "Configured boundary",
        reason: `Image associated with recent result: ${title || snippet}`,
        discoveredAt,
      });
    }
  }
  return { entries, imageExamples };
}

export function mergeMemory(
  existing: SpoilerMemory,
  updates: Partial<SpoilerMemory>,
  options: { maxEntriesPerRule: number; maxImageExamplesPerRule: number },
): SpoilerMemory {
  const next = normalizeMemory(existing);
  return {
    ...next,
    ...updates,
    entries: trimByRule(mergeById(updates.entries ?? [], next.entries), options.maxEntriesPerRule),
    imageExamples: trimByRule(mergeById(updates.imageExamples ?? [], next.imageExamples), options.maxImageExamplesPerRule),
    lastUpdatedAt: updates.lastUpdatedAt || new Date().toISOString(),
    lastError: updates.lastError || "",
    ruleRuns: { ...next.ruleRuns, ...(updates.ruleRuns ?? {}) },
  };
}

export function buildMemoryContext(memory: SpoilerMemory, ruleId: string, limit = 6): string {
  const normalized = normalizeMemory(memory);
  const lines = normalized.entries.filter((entry) => entry.ruleId === ruleId).slice(0, limit).map((entry) => (
    `Detail: ${entry.title || entry.snippet}. Terms: ${entry.terms.slice(0, 6).join(", ")}. Why: ${entry.reason}`
  ));
  lines.push(...normalized.imageExamples.filter((entry) => entry.ruleId === ruleId).slice(0, 4).map((image) => (
    `Spoiler image example: ${image.title || image.imageUrl}. Label: ${image.label}. Why: ${image.reason}`
  )));
  return lines.join("\n");
}

export function memoryMatch(text: string, rules: BlockingRule[], memory: SpoilerMemory): Match | null {
  const source = normalizeComparableText(text);
  if (!source) return null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const entries = memory.entries.filter((entry) => entry.ruleId === rule.id).slice(0, 12);
    for (const entry of entries) {
      const phrase = normalizeComparableText(entry.title);
      if (phrase.length >= 12 && source.includes(phrase)) {
        return { ruleId: rule.id, ruleName: rule.name, reason: `recent detail: ${entry.title}` };
      }
      const terms = entry.terms.filter((term) => term.length >= 4);
      const matched = terms.filter((term) => source.includes(normalizeComparableText(term)));
      if (matched.length >= Math.min(2, terms.length || 2)) {
        return { ruleId: rule.id, ruleName: rule.name, reason: `recent terms: ${matched.slice(0, 3).join(", ")}` };
      }
    }
  }
  return null;
}

export function summarizeMemory(memory: SpoilerMemory): MemorySummary {
  const normalized = normalizeMemory(memory);
  return {
    enabled: normalized.enabled,
    lastUpdatedAt: normalized.lastUpdatedAt,
    lastError: normalized.lastError,
    entryCount: normalized.entries.length,
    imageExampleCount: normalized.imageExamples.length,
    ruleRuns: normalized.ruleRuns,
  };
}

export function significantTerms(value: string, limit = 12): string[] {
  return Array.from(new Set(normalizeComparableText(value).split(" ").filter((word) => (
    word.length >= 4 && !STOP_WORDS.has(word) && !/^\d+$/.test(word)
  )))).slice(0, limit);
}

function mergeById<T extends { id: string }>(newItems: T[], oldItems: T[]): T[] {
  const seen = new Set<string>();
  return [...newItems, ...oldItems].filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function trimByRule<T extends { ruleId: string }>(items: T[], maxPerRule: number): T[] {
  const counts = new Map<string, number>();
  return items.filter((item) => {
    const count = counts.get(item.ruleId) ?? 0;
    if (count >= maxPerRule) return false;
    counts.set(item.ruleId, count + 1);
    return true;
  });
}

function readTag(text: string, tagName: string): string {
  const match = text.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match?.[1] ? decodeEntities(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")) : "";
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function cleanText(value: string): string {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)));
}

function extractImageUrls(block: string, description: string): string[] {
  const urls: string[] = [];
  const expression = /(?:media:content|media:thumbnail|img)[^>]+(?:url|src)=["']([^"']+)["']/gi;
  let match = expression.exec(`${block} ${description}`);
  while (match) {
    if (match[1] && /^https?:\/\//i.test(match[1])) urls.push(decodeEntities(match[1]));
    match = expression.exec(`${block} ${description}`);
  }
  return Array.from(new Set(urls));
}

function stableId(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  return `m_${(hash >>> 0).toString(36)}`;
}
