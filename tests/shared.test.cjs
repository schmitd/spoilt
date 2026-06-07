const assert = require('node:assert/strict');
const shared = require('../src/shared.js');

const settings = shared.normalizeSettings({
  rules: [
    { id: 'sports', name: 'Sports results', description: 'Winners and scores', keywords: ['final score', 'wins championship'] }
  ]
});

assert.equal(settings.rules.length, 1);
assert.equal(settings.strictness, 'balanced');
assert.deepEqual(shared.parseKeywordInput('winner, finale\npost credit'), ['winner', 'finale', 'post credit']);
assert.equal(shared.keywordMatch('The FINAL SCORE was 3-2', settings.rules).ruleId, 'sports');
assert.equal(shared.keywordMatch('A harmless preview', settings.rules), null);
assert.equal(shared.normalizeComparableText('Finale: “Twist”!'), 'finale "twist"');
assert.match(shared.buildRulesSummary(settings.rules), /Sports results/);
assert.match(shared.strictnessGuidance('strict'), /clearly/);

console.log('shared.test.cjs passed');
