import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY,
  buildGoogleNewsRssUrl,
  buildMemoryContext,
  extractRssItems,
  memoryMatch,
  mergeMemory,
  summarizeMemory,
} from "./memory";
import type { BlockingRule } from "./types";

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
    }, { maxEntriesPerRule: 4, maxImageExamplesPerRule: 4 });
    expect(summarizeMemory(merged).entryCount).toBe(1);
    expect(buildMemoryContext(merged, rule.id)).toContain("masked winner");
    expect(memoryMatch("Show X finale reveals the masked winner today.", [rule], merged)?.ruleId).toBe(rule.id);
  });

  it("builds a Google News RSS query", () => {
    expect(buildGoogleNewsRssUrl(rule)).toContain("news.google.com");
  });
});
