import type { BlockingRule, Match, Settings } from "./types";
import { normalizeSettings } from "./settings";

/** Names organize the UI; only these fields define a boundary's behavior. */
export function ruleCriteria(rule: BlockingRule) {
  return { id: rule.id, description: rule.description, keywords: [...rule.keywords], enabled: rule.enabled };
}

export function ruleCriteriaKey(rule: BlockingRule): string { return JSON.stringify(ruleCriteria(rule)); }

export function criteriaSettings(settings: Settings) {
  return { ...settings, rules: activeCriteriaRules(settings.rules).map(ruleCriteria) };
}

export function criteriaSettingsChanged(change: { oldValue?: unknown; newValue?: unknown }): boolean {
  if (change.oldValue === undefined || change.newValue === undefined) return true;
  return JSON.stringify(criteriaSettings(normalizeSettings(change.oldValue)))
    !== JSON.stringify(criteriaSettings(normalizeSettings(change.newValue)));
}

export function activeCriteriaRules(rules: BlockingRule[]): BlockingRule[] {
  return rules.filter((rule) => rule.enabled && (rule.description.trim() || rule.keywords.some((keyword) => keyword.trim())));
}

export function relabelMatch(match: Match, rules: BlockingRule[]): Match {
  const rule = rules.find((rule) => rule.id === match.ruleId);
  return rule && rule.name !== match.ruleName ? { ...match, ruleName: rule.name } : match;
}
