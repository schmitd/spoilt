import type { BlockingRule, Match, Strictness } from "./types";

const FALLBACK_STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "avoid", "block", "but", "can", "content", "details",
  "does", "dont", "from", "has", "hide", "include", "includes", "including", "into", "major",
  "not", "online", "other", "should", "show", "that", "the", "their", "them", "then", "there",
  "these", "thing", "this", "those", "through", "when", "where", "with", "what", "will",
]);

export function keywordMatch(text: string, rules: BlockingRule[]): Match | null {
  const source = normalizeComparableText(text);
  if (!source) return null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const keyword of rule.keywords) {
      const needle = normalizeComparableText(keyword);
      if (needle && source.includes(needle)) {
        return { ruleId: rule.id, ruleName: rule.name, reason: `keyword: ${keyword}` };
      }
    }
  }
  return null;
}

export function descriptionMatch(text: string, rules: BlockingRule[]): Match | null {
  const source = normalizeComparableText(text);
  if (!source) return null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const terms = fallbackTerms(rule);
    const matched = terms.filter((term) => source.includes(term));
    if (matched.length >= Math.min(2, terms.length)) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        reason: `description fallback: ${matched.slice(0, 3).join(", ")}`,
      };
    }
  }
  return null;
}

export function normalizeComparableText(text: unknown): string {
  return String(text ?? "")
    .toLocaleLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, "\"")
    .replace(/[^\p{L}\p{N}'" ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeWhitespace(text: unknown): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function buildRulesSummary(rules: BlockingRule[]): string {
  return rules.filter((rule) => rule.enabled).map((rule, index) => {
    const keywords = rule.keywords.slice(0, 20).join(", ") || "none";
    return `${index + 1}. ${rule.name}: ${rule.description || "No description."} Keywords: ${keywords}`;
  }).join("\n");
}

export function strictnessGuidance(strictness: Strictness): string {
  if (strictness === "loose") return "Mask content when it probably relates to any rule, including indirect hints.";
  if (strictness === "strict") return "Mask only when the content clearly and specifically matches a rule.";
  return "Mask when there is a clear semantic match. Do not mask generic unrelated text.";
}

function fallbackTerms(rule: BlockingRule): string[] {
  const input = `${rule.name} ${rule.description}`;
  const quoted = input.match(/"([^"]+)"|'([^']+)'/g) ?? [];
  const phrases = quoted.map((phrase) => normalizeComparableText(phrase.slice(1, -1))).filter((phrase) => phrase.length >= 4);
  const words = normalizeComparableText(input).split(" ").filter((word) => (
    word.length >= 4 && !FALLBACK_STOP_WORDS.has(word) && !/^\d+$/.test(word)
  ));
  return Array.from(new Set([...phrases, ...words])).slice(0, 30);
}
