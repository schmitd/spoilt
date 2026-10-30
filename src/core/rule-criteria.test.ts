import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import { activeCriteriaRules, criteriaSettings, criteriaSettingsChanged, relabelMatch, ruleCriteriaKey } from "./rule-criteria";

const settings = { ...DEFAULT_SETTINGS, rules: [{ id: "stable", name: "Organizational title", description: "race outcomes", keywords: ["podium"], enabled: true }] };
const renamed = { ...settings, rules: [{ ...settings.rules[0]!, name: "Different label" }] };

describe("rule labels and criteria", () => {
  it("leaves criteria and provenance identical after a label-only rename", () => {
    expect(criteriaSettings(renamed)).toEqual(criteriaSettings(settings));
    expect(ruleCriteriaKey(renamed.rules[0]!)).toBe(ruleCriteriaKey(settings.rules[0]!));
    expect(criteriaSettingsChanged({ oldValue: settings, newValue: renamed })).toBe(false);
    expect(criteriaSettingsChanged({ oldValue: settings, newValue: { ...renamed, rules: [{ ...renamed.rules[0]!, keywords: ["finishing order"] }] } })).toBe(true);
    expect(criteriaSettingsChanged({ newValue: renamed })).toBe(true);
  });

  it("requires actual description or explicit keywords to activate a rule", () => {
    expect(activeCriteriaRules([{ ...settings.rules[0]!, description: "", keywords: [] }])).toEqual([]);
    expect(activeCriteriaRules([{ ...settings.rules[0]!, description: "", keywords: ["Organizational title"] }])).toHaveLength(1);
    const labelOnly = { id: "inert", name: "Optional category", description: "", keywords: [], enabled: true };
    expect(criteriaSettingsChanged({ oldValue: { ...settings, rules: [...settings.rules, labelOnly] },
      newValue: { ...settings, rules: [...settings.rules, { ...labelOnly, name: "" }] } })).toBe(false);
  });

  it("refreshes a display label without changing a decision or its reason", () => {
    const match = { ruleId: "stable", ruleName: "Organizational title", reason: "keyword: podium" };
    expect(relabelMatch(match, renamed.rules)).toEqual({ ...match, ruleName: "Different label" });
  });
});
