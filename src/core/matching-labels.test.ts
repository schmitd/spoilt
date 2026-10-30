import { describe, expect, it } from "vitest";
import { buildRulesSummary, descriptionMatch, keywordMatch } from "./matching";
import type { BlockingRule } from "./types";

const rule: BlockingRule = { id: "r", name: "Gardening orchids", description: "Race finishing order and qualifying outcomes", keywords: ["final score"], enabled: true };

describe("display-only rule names", () => {
  it("does not use label words or quoted label phrases as fallback criteria", () => {
    expect(descriptionMatch("Gardening orchids are blooming", [rule])).toBeNull();
    expect(descriptionMatch("a private quoted title", [{ ...rule, name: '"private quoted title"' }])).toBeNull();
    const source = "The qualifying outcomes changed the finishing order";
    expect(descriptionMatch(source, [rule])?.ruleId).toBe("r");
    expect(descriptionMatch(source, [{ ...rule, name: "Unrelated label" }])?.ruleId).toBe("r");
  });

  it("leaves label-only and empty fallback rules inert instead of matching every text", () => {
    for (const name of ["Gardening orchids", "AI", ""]) {
      const empty = { ...rule, name, description: "", keywords: [] };
      expect(descriptionMatch("Any ordinary page text", [empty])).toBeNull();
      expect(keywordMatch("Gardening orchids", [empty])).toBeNull();
    }
  });

  it("preserves explicit keywords even when identical to the display label", () => {
    const explicit = { ...rule, description: "", keywords: [rule.name] };
    expect(keywordMatch("Gardening orchids are blooming", [explicit])?.ruleName).toBe(rule.name);
    expect(keywordMatch("Gardening orchids are blooming", [{ ...explicit, name: "Other label" }])?.ruleId).toBe("r");
  });

  it("uses opaque attribution aliases and criteria in semantic summaries", () => {
    const summary = buildRulesSummary([rule]);
    expect(summary).not.toContain(rule.name);
    expect(summary).toContain("boundary-1");
    expect(summary).toContain(rule.description);
    expect(summary).toContain("final score");
    expect(buildRulesSummary([{ ...rule, name: "Other label" }])).toBe(summary);
    expect(buildRulesSummary([{ ...rule, description: "", keywords: [] }])).toBe("");
  });
});
