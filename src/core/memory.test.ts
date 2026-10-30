import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY,
  buildGoogleNewsRssUrl,
  buildMemoryContext,
  buildRuleSearchQuery,
  extractRssItems,
  memoryMatch,
  mergeMemory,
  matchingMemorySignature,
  normalizeMemory,
  summarizeMemory,
} from "./memory";
import type { BlockingRule } from "./types";
import { ruleCriteriaKey } from "./rule-criteria";

const rule: BlockingRule = {
  id: "show-x",
  name: "Show X spoilers",
  description: "Block finale deaths and winner reveals for Show X.",
  keywords: [],
  enabled: true,
};

const rss = `<?xml version="1.0"?><rss><channel><item>
  <title><![CDATA[Show X finale reveals the masked winner]]></title>
  <link>https://example.com/finale</link>
  <source>Example News</source>
  <pubDate>Sun, 07 Jun 2026 01:00:00 GMT</pubDate>
  <description><![CDATA[The last episode confirms the winner and includes <img src="https://cdn.example.com/winner.jpg">]]></description>
  <media:thumbnail url="https://cdn.example.com/thumb.jpg" />
</item></channel></rss>`;

describe("spoiler memory", () => {
  it("extracts, merges, summarizes, and matches public result context", () => {
    const extracted = extractRssItems(rss, rule, "2026-06-07T00:00:00.000Z");
    expect(extracted.entries).toHaveLength(1);
    expect(extracted.imageExamples.length).toBeGreaterThanOrEqual(1);
    const merged = mergeMemory(DEFAULT_MEMORY, {
      entries: extracted.entries,
      imageExamples: extracted.imageExamples,
      lastUpdatedAt: "2026-06-07T00:00:00.000Z",
      ruleRuns: { [rule.id]: { criteriaKey: ruleCriteriaKey(rule), at: "2026-06-07T00:00:00.000Z", reason: "manual",
        query: buildRuleSearchQuery(rule), resultCount: extracted.entries.length, imageExampleCount: extracted.imageExamples.length } },
    }, { maxEntriesPerRule: 4, maxImageExamplesPerRule: 4 });
    expect(summarizeMemory(merged).entryCount).toBe(1);
    expect(buildMemoryContext(merged, rule)).toContain("masked winner");
    expect(memoryMatch("Show X finale reveals the masked winner today.", [rule], merged)?.ruleId).toBe(rule.id);
  });

  it("builds a Google News RSS query", () => {
    expect(buildGoogleNewsRssUrl(rule)).toContain("news.google.com");
  });

  it("uses description and explicit keywords, with no title-derived public search", () => {
    const criteria = { ...rule, name: "Unrelated display-only title", keywords: ["NBA", "F1"] };
    const query = buildRuleSearchQuery(criteria);
    expect(query).toContain("nba"); expect(query).toContain("f1"); expect(query).toContain("finale");
    expect(query).not.toContain("unrelated"); expect(query).not.toContain("display");
    expect(buildRuleSearchQuery({ ...criteria, name: "A completely different label" })).toBe(query);
    expect(buildGoogleNewsRssUrl({ ...criteria, name: "A completely different label" })).toBe(buildGoogleNewsRssUrl(criteria));
  });

  it.each([
    { description: "", keywords: [] },
    { description: "   ", keywords: [" "] },
    { description: "spoilers and news", keywords: [] },
  ])("does not substitute a generic query when actual search criteria are empty: %j", (criteria) => {
    const labelOnly = { ...rule, ...criteria, name: "A very specific scary story title" };
    expect(buildRuleSearchQuery(labelOnly)).toBe("");
    expect(buildGoogleNewsRssUrl(labelOnly)).toBe("");
  });
});

function trustedMemory() {
  const extracted = extractRssItems(rss, rule, "2026-06-07T00:00:00.000Z");
  return normalizeMemory({ entries: extracted.entries, imageExamples: extracted.imageExamples,
    ruleRuns: { [rule.id]: { criteriaKey: ruleCriteriaKey(rule), at: "2026-06-07T00:00:00.000Z", reason: "manual",
      query: buildRuleSearchQuery(rule), resultCount: extracted.entries.length, imageExampleCount: extracted.imageExamples.length } } });
}

describe("criteria-bound public memory", () => {
  it("preserves legacy history while excluding it from matching and model context", () => {
    const memory = trustedMemory(); delete memory.ruleRuns[rule.id]!.criteriaKey;
    const before = JSON.stringify(memory);
    expect(memoryMatch("Show X finale reveals the masked winner today.", [rule], memory)).toBeNull();
    expect(buildMemoryContext(memory, rule)).toBe("");
    expect(buildMemoryContext(memory, rule.id)).toBe("");
    expect(matchingMemorySignature(memory, [rule])).toBe("[]");
    expect(JSON.stringify(memory)).toBe(before);
  });

  it("ignores knowledge produced for different criteria without deleting it", () => {
    const memory = trustedMemory(); const changed = { ...rule, description: "Basketball match results", keywords: ["NBA"] };
    const before = JSON.stringify(memory);
    expect(memoryMatch("Show X finale reveals the masked winner today.", [changed], memory)).toBeNull();
    expect(buildMemoryContext(memory, changed)).toBe("");
    expect(matchingMemorySignature(memory, [changed])).toBe("[]");
    expect(JSON.stringify(memory)).toBe(before);
  });

  it("does not make a title-only rule active through stored article knowledge", () => {
    const labelOnly = { ...rule, description: "", keywords: [] };
    const memory = trustedMemory(); memory.ruleRuns[rule.id]!.criteriaKey = ruleCriteriaKey(labelOnly);
    expect(memoryMatch("Show X finale reveals the masked winner today.", [labelOnly], memory)).toBeNull();
    expect(buildMemoryContext(memory, labelOnly)).toBe("");
    expect(matchingMemorySignature(memory, [labelOnly])).toBe("[]");
  });

  it("removes stored rule-derived reasons and labels while retaining actual article data", () => {
    const memory = trustedMemory();
    memory.entries[0]!.reason = "Original private display label";
    for (const image of memory.imageExamples) { image.label = "Original private display label"; image.reason = "Original private display label"; }
    const context = buildMemoryContext(memory, rule);
    expect(context).toContain("masked winner"); expect(context).toContain("last episode confirms");
    expect(context).toContain("https://example.com/finale"); expect(context).toContain("https://cdn.example.com/");
    expect(context).not.toContain("Original private display label"); expect(context).not.toContain(rule.name);
    expect(matchingMemorySignature(memory, [rule])).not.toContain("Original private display label");
  });

  it("preserves criteria, public context and semantic identity across a rename", () => {
    const memory = trustedMemory(); const renamed = { ...rule, name: "A totally unrelated display label" };
    expect(ruleCriteriaKey(renamed)).toBe(ruleCriteriaKey(rule));
    expect(buildMemoryContext(memory, renamed)).toBe(buildMemoryContext(memory, rule));
    expect(matchingMemorySignature(memory, [renamed])).toBe(matchingMemorySignature(memory, [rule]));
    expect(memoryMatch("Show X finale reveals the masked winner today.", [renamed], memory)).toMatchObject({ ruleId: rule.id, ruleName: renamed.name });
  });

  it("keeps display fields and refresh bookkeeping out of the memory signature", () => {
    const memory = trustedMemory(); const original = matchingMemorySignature(memory, [rule]);
    memory.lastUpdatedAt = "a new refresh time"; memory.lastError = "a display-only error";
    memory.ruleRuns[rule.id]!.at = "a new run time"; memory.ruleRuns[rule.id]!.query = "old label in historical query";
    memory.entries[0]!.reason = "renamed UI label"; memory.entries[0]!.discoveredAt = "new discovery time";
    memory.imageExamples[0]!.label = "renamed UI label"; memory.imageExamples[0]!.reason = "renamed UI reason";
    memory.imageExamples[0]!.discoveredAt = "new discovery time";
    expect(matchingMemorySignature(memory, [rule])).toBe(original);
    memory.entries[0]!.snippet = "A genuinely different article detail";
    expect(matchingMemorySignature(memory, [rule])).not.toBe(original);
  });
});
