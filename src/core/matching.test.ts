import { describe, expect, it } from "vitest";
import { descriptionMatch, keywordMatch, normalizeComparableText, strictnessGuidance } from "./matching";
import type { BlockingRule } from "./types";

const rule: BlockingRule = {
  id: "sports",
  name: "Formula 1 results",
  description: "Winners, podiums, qualifying results, and championship standings.",
  keywords: ["final score", "wins championship"],
  enabled: true,
};

describe("matching", () => {
  it("matches direct keywords case-insensitively", () => {
    expect(keywordMatch("The FINAL SCORE was 3-2", [rule])?.ruleId).toBe("sports");
  });

  it("matches meaningful description terms", () => {
    expect(descriptionMatch("The qualifying results changed the championship standings", [rule])?.ruleId).toBe("sports");
  });

  it("skips disabled boundaries", () => {
    expect(keywordMatch("final score", [{ ...rule, enabled: false }])).toBeNull();
  });

  it("normalizes punctuation and quotes", () => {
    expect(normalizeComparableText("Finale: “Twist”!")).toBe('finale "twist"');
    expect(strictnessGuidance("strict")).toContain("clearly");
  });
});
