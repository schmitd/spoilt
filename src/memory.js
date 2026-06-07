(function (root) {
  "use strict";

  const MEMORY_KEY = "spoilt.memory";
  const DEFAULT_MEMORY = {
    version: 1,
    enabled: true,
    lastUpdatedAt: "",
    lastError: "",
    entries: [],
    imageExamples: [],
    ruleRuns: {}
  };

  const MEMORY_STOP_WORDS = new Set([
    "about", "after", "also", "and", "are", "before", "block", "but", "can", "content", "details",
    "does", "from", "have", "into", "just", "latest", "major", "more", "news", "not", "official",
    "other", "over", "reveals", "should", "show", "spoiler", "spoilers", "that", "the", "their", "them",
    "then", "there", "these", "this", "those", "through", "update", "when", "where", "with", "what",
    "will", "would", "your"
  ]);

  function normalizeMemory(value) {
    const memory = { ...DEFAULT_MEMORY, ...(value || {}) };
    memory.entries = Array.isArray(memory.entries) ? memory.entries : [];
    memory.imageExamples = Array.isArray(memory.imageExamples) ? memory.imageExamples : [];
    memory.ruleRuns = memory.ruleRuns && typeof memory.ruleRuns === "object" ? memory.ruleRuns : {};
    return memory;
  }

  function buildRuleSearchQuery(rule) {
    const pieces = [rule.name, rule.description, ...(rule.keywords || []).slice(0, 8)]
      .filter(Boolean)
      .join(" ");
    const terms = significantTerms(pieces, 12);
    return terms.length ? terms.join(" ") : String(rule.name || "spoiler");
  }

  function buildGoogleNewsRssUrl(rule) {
    const query = `${buildRuleSearchQuery(rule)} spoiler OR leak OR ending OR reveal`;
    return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  }

  function extractRssItems(xml, rule, discoveredAt) {
    const items = [];
    const imageExamples = [];
    const blocks = String(xml || "").match(/<item[\s\S]*?<\/item>/gi) || [];
    for (const block of blocks.slice(0, 12)) {
      const title = cleanText(readTag(block, "title"));
      const rawDescription = readTag(block, "description");
      const snippet = cleanText(stripTags(rawDescription));
      const url = cleanText(readTag(block, "link"));
      const source = cleanText(readTag(block, "source"));
      const publishedAt = cleanText(readTag(block, "pubDate"));
      if (!title && !snippet) continue;
      const terms = significantTerms(`${title} ${snippet}`, 10);
      const id = stableId(`${rule.id}|${title}|${url}`);
      items.push({
        id,
        ruleId: rule.id,
        title,
        snippet,
        url,
        source,
        publishedAt,
        discoveredAt,
        terms,
        reason: `Recent web result for ${rule.name || "configured rule"}`
      });
      for (const imageUrl of extractImageUrls(block, rawDescription).slice(0, 2)) {
        imageExamples.push({
          id: stableId(`${rule.id}|${imageUrl}|${title}`),
          ruleId: rule.id,
          imageUrl,
          sourceUrl: url,
          title,
          label: rule.name || "Configured spoiler",
          reason: `Image associated with recent result: ${title || snippet}`,
          discoveredAt
        });
      }
    }
    return { entries: items, imageExamples };
  }

  function mergeMemory(existing, updates, options) {
    const maxEntriesPerRule = clampNumber(options && options.maxEntriesPerRule, 4, 80, 16);
    const maxImageExamplesPerRule = clampNumber(options && options.maxImageExamplesPerRule, 2, 40, 8);
    const next = normalizeMemory(existing);
    next.entries = mergeById(updates.entries || [], next.entries).filter(Boolean);
    next.imageExamples = mergeById(updates.imageExamples || [], next.imageExamples).filter(Boolean);
    next.entries = trimByRule(next.entries, maxEntriesPerRule);
    next.imageExamples = trimByRule(next.imageExamples, maxImageExamplesPerRule);
    next.lastUpdatedAt = updates.lastUpdatedAt || new Date().toISOString();
    next.lastError = updates.lastError || "";
    next.ruleRuns = { ...next.ruleRuns, ...(updates.ruleRuns || {}) };
    return next;
  }

  function buildMemoryContext(memory, ruleId, limit) {
    const normalized = normalizeMemory(memory);
    const entries = normalized.entries.filter((entry) => entry.ruleId === ruleId).slice(0, limit || 6);
    const images = normalized.imageExamples.filter((entry) => entry.ruleId === ruleId).slice(0, 4);
    const lines = [];
    for (const entry of entries) {
      lines.push(`Detail: ${entry.title || entry.snippet}. Terms: ${(entry.terms || []).slice(0, 6).join(", ")}. Why: ${entry.reason}`);
    }
    for (const image of images) {
      lines.push(`Spoiler image example: ${image.title || image.imageUrl}. Label: ${image.label}. Why: ${image.reason}`);
    }
    return lines.join("\n");
  }

  function memoryMatch(text, rules, memory) {
    const source = normalizeComparableText(text);
    if (!source) return null;
    const normalized = normalizeMemory(memory);
    for (const rule of rules || []) {
      const entries = normalized.entries.filter((entry) => entry.ruleId === rule.id).slice(0, 12);
      for (const entry of entries) {
        const phrase = normalizeComparableText(entry.title || "");
        if (phrase.length >= 12 && source.includes(phrase)) {
          return { ruleId: rule.id, ruleName: rule.name, reason: `memory detail: ${entry.title}` };
        }
        const terms = (entry.terms || []).filter((term) => term.length >= 4);
        const matched = terms.filter((term) => source.includes(normalizeComparableText(term)));
        if (matched.length >= Math.min(2, terms.length || 2)) {
          return { ruleId: rule.id, ruleName: rule.name, reason: `memory terms: ${matched.slice(0, 3).join(", ")}` };
        }
      }
    }
    return null;
  }

  function summarizeMemory(memory) {
    const normalized = normalizeMemory(memory);
    return {
      enabled: normalized.enabled,
      lastUpdatedAt: normalized.lastUpdatedAt,
      lastError: normalized.lastError,
      entryCount: normalized.entries.length,
      imageExampleCount: normalized.imageExamples.length,
      ruleRuns: normalized.ruleRuns
    };
  }

  function mergeById(newItems, oldItems) {
    const seen = new Set();
    const merged = [];
    for (const item of [...newItems, ...oldItems]) {
      if (!item || !item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
    return merged;
  }

  function trimByRule(items, maxPerRule) {
    const counts = new Map();
    return items.filter((item) => {
      const key = item.ruleId || "unknown";
      const count = counts.get(key) || 0;
      if (count >= maxPerRule) return false;
      counts.set(key, count + 1);
      return true;
    });
  }

  function readTag(text, tagName) {
    const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
    const match = String(text || "").match(re);
    return match ? decodeEntities(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")) : "";
  }

  function stripTags(value) {
    return String(value || "").replace(/<[^>]+>/g, " ");
  }

  function cleanText(value) {
    return decodeEntities(String(value || "")).replace(/\s+/g, " ").trim();
  }

  function decodeEntities(value) {
    return String(value || "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
  }

  function extractImageUrls(block, description) {
    const urls = [];
    const text = `${block || ""} ${description || ""}`;
    const attrRe = /(?:media:content|media:thumbnail|img)[^>]+(?:url|src)=["']([^"']+)["']/gi;
    let match = attrRe.exec(text);
    while (match) {
      if (/^https?:\/\//i.test(match[1])) urls.push(decodeEntities(match[1]));
      match = attrRe.exec(text);
    }
    return Array.from(new Set(urls));
  }

  function significantTerms(value, limit) {
    return Array.from(new Set(normalizeComparableText(value).split(" ").filter((word) => {
      return word.length >= 4 && !MEMORY_STOP_WORDS.has(word) && !/^\d+$/.test(word);
    }))).slice(0, limit || 12);
  }

  function normalizeComparableText(text) {
    return String(text || "")
      .toLocaleLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[^\p{L}\p{N}'" ]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stableId(value) {
    let hash = 5381;
    const text = String(value || "");
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    }
    return `m_${(hash >>> 0).toString(36)}`;
  }

  function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, Math.round(numeric)));
  }

  const api = {
    MEMORY_KEY,
    DEFAULT_MEMORY,
    normalizeMemory,
    buildRuleSearchQuery,
    buildGoogleNewsRssUrl,
    extractRssItems,
    mergeMemory,
    buildMemoryContext,
    memoryMatch,
    summarizeMemory,
    significantTerms
  };

  Object.assign(root, api);
  if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
