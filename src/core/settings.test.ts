import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings, parseKeywordInput } from "./settings";

describe("settings", () => {
  it("migrates legacy rules and adds v2 defaults", () => {
    const settings = normalizeSettings({
      enabled: false,
      rules: [{ id: "sports", name: "Sports results", description: "Scores", keywords: ["winner"] }],
    });
    expect(settings.version).toBe(2);
    expect(settings.enabled).toBe(false);
    expect(settings.redactionStyle).toBe("whiteout");
    expect(settings.rules[0]).toMatchObject({ id: "sports", enabled: true });
  });

  it("preserves an intentional empty boundary list", () => {
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, rules: [] }).rules).toEqual([]);
  });

  it("accepts common keyword separators and deduplicates input", () => {
    expect(parseKeywordInput("winner, finale\npodium; qualifying winner")).toEqual([
      "winner",
      "finale",
      "podium",
      "qualifying",
    ]);
  });
});
