import { normalizeComparableText } from "./matching";
import { activeCriteriaRules, ruleCriteriaKey } from "./rule-criteria";
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
  // Explicit keywords are criteria even when short (for example NBA or F1).
  // Labels and a generic fallback must never create a public search on their own.
  const keywords = rule.keywords.map((keyword) => normalizeComparableText(keyword)).filter(Boolean).slice(0, 8);
  const terms = [...new Set([...keywords, ...significantTerms(rule.description, 12)])].slice(0, 12);
  return terms.join(" ");
}

export function buildGoogleNewsRssUrl(rule: BlockingRule): string {
  const criteria = buildRuleSearchQuery(rule);
  if (!criteria) return "";
  const query = `${criteria} spoiler OR leak OR ending OR reveal`;
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
      reason: "Recent public result for configured criteria",
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

export function buildMemoryContext(memory: SpoilerMemory, rule: BlockingRule | string, limit = 6): string {
  const normalized = normalizeMemory(memory);
  // An id alone cannot establish which criteria produced stored public results.
  if (typeof rule === "string" || !hasCurrentCriteria(normalized, rule)) return "";
  const lines = normalized.entries.filter((entry) => entry.ruleId === rule.id).slice(0, limit).map((entry) => (
    `Detail: ${entry.title}. Summary: ${entry.snippet}. Terms: ${entry.terms.slice(0, 6).join(", ")}. Source: ${entry.source}. URL: ${entry.url}`
  ));
  lines.push(...normalized.imageExamples.filter((entry) => entry.ruleId === rule.id).slice(0, 4).map((image) => (
    `Public image example: ${image.title}. Image URL: ${image.imageUrl}. Source URL: ${image.sourceUrl}`
  )));
  return lines.join("\n");
}

/** Only data used for matching/model context; presentation and refresh bookkeeping are excluded. */
export function matchingMemorySignature(memory: SpoilerMemory, rules: BlockingRule[]): string {
  const normalized = normalizeMemory(memory);
  return JSON.stringify(activeCriteriaRules(rules).filter((rule) => hasCurrentCriteria(normalized, rule)).flatMap((rule) => {
    const entries = normalized.entries.filter((entry) => entry.ruleId === rule.id).slice(0, 12).map((entry) => ({
      title: entry.title, snippet: entry.snippet, terms: entry.terms, source: entry.source, url: entry.url,
    }));
    const images = normalized.imageExamples.filter((image) => image.ruleId === rule.id).slice(0, 4).map((image) => ({
      title: image.title, imageUrl: image.imageUrl, sourceUrl: image.sourceUrl,
    }));
    return entries.length || images.length ? [{ ruleId: rule.id, criteriaKey: ruleCriteriaKey(rule), entries, images }] : [];
  }));
}

export function memoryMatch(text: string, rules: BlockingRule[], memory: SpoilerMemory): Match | null {
  const source = normalizeComparableText(text);
  if (!source) return null;
  for (const rule of rules) {
    if (!hasCurrentCriteria(memory, rule)) continue;
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

function hasCurrentCriteria(memory: SpoilerMemory, rule: BlockingRule): boolean {
  return memory.enabled && activeCriteriaRules([rule]).length > 0
    && memory.ruleRuns[rule.id]?.criteriaKey === ruleCriteriaKey(rule);
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
