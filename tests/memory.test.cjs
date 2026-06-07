const assert = require('node:assert/strict');
const memory = require('../src/memory.js');

const rule = {
  id: 'show-x',
  name: 'Show X spoilers',
  description: 'Block finale deaths and winner reveals for Show X.',
  keywords: []
};

const rss = `<?xml version="1.0"?><rss><channel>
<item>
<title><![CDATA[Show X finale reveals the masked winner]]></title>
<link>https://example.com/finale</link>
<source>Example News</source>
<pubDate>Sun, 07 Jun 2026 01:00:00 GMT</pubDate>
<description><![CDATA[The last episode confirms the winner and includes <img src="https://cdn.example.com/winner.jpg">]]></description>
<media:thumbnail url="https://cdn.example.com/thumb.jpg" />
</item>
</channel></rss>`;

const extracted = memory.extractRssItems(rss, rule, '2026-06-07T00:00:00.000Z');
assert.equal(extracted.entries.length, 1);
assert.equal(extracted.entries[0].ruleId, 'show-x');
assert.ok(extracted.entries[0].terms.includes('finale'));
assert.ok(extracted.imageExamples.length >= 1);
assert.match(extracted.imageExamples[0].reason, /Image associated/);

const merged = memory.mergeMemory(memory.DEFAULT_MEMORY, {
  entries: extracted.entries,
  imageExamples: extracted.imageExamples,
  lastUpdatedAt: '2026-06-07T00:00:00.000Z'
}, { maxEntriesPerRule: 4, maxImageExamplesPerRule: 4 });

assert.equal(memory.summarizeMemory(merged).entryCount, 1);
assert.match(memory.buildMemoryContext(merged, 'show-x'), /masked winner/);
assert.equal(memory.memoryMatch('A page says Show X finale reveals the masked winner today.', [rule], merged).ruleId, 'show-x');
assert.match(memory.buildGoogleNewsRssUrl(rule), /news\.google\.com/);

console.log('memory.test.cjs passed');
