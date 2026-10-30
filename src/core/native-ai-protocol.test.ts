import { describe, expect, it } from "vitest";
import { MAX_DATA_URL_LENGTH, MAX_RULE_ID_LENGTH, validateNativeInput, validateNativeResponse, type NativeInput } from "./native-ai-protocol";

describe("native classification protocol", () => {
  it.each([
    { kind: "text", texts: ["ok"], prompt: "arbitrary instruction" },
    { kind: "text", texts: Array(19).fill("a") },
    { kind: "text", texts: ["a".repeat(601)] },
    { kind: "text", texts: [] },
    { kind: "image", metadata: "", dataUrl: "https://site.test/private-image" },
    { kind: "image", metadata: "", dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" },
    { kind: "image", metadata: "", dataUrl: `data:image/png;base64,${"A".repeat(MAX_DATA_URL_LENGTH)}` },
    { kind: "capabilities", prompt: "run this" },
  ])("rejects unbounded inputs and arbitrary prompt fields: %j", (input) => {
    expect(validateNativeInput(input)).toBe(false);
  });

  it("accepts bounded text and image data only", () => {
    expect(validateNativeInput({ kind: "text", texts: ["A scene"] })).toBe(true);
    expect(validateNativeInput({ kind: "image", metadata: "A scene", dataUrl: "data:image/png;base64,AAAA" })).toBe(true);
  });

  it.each([
    { decisions: [{ i: 1, block: true }] }, { decisions: [{ i: -1, block: true }] }, { decisions: [{ i: 0, block: "true" }] },
    { decisions: [{ i: 0, block: true }, { i: 0, block: true }] }, { decisions: [{ i: 0, block: true, reason: "a".repeat(401) }] },
  ])("rejects invalid or duplicate model decisions: %j", ({ decisions }) => {
    expect(validateNativeResponse({ kind: "text", texts: ["bounded"] }, { ok: true, decisions })).toBe(false);
  });

  const responseInputs: NativeInput[] = [
    { kind: "text", texts: ["bounded"] },
    { kind: "image", metadata: "", dataUrl: "data:image/png;base64,AAAA" },
  ];
  it.each(responseInputs)("accepts optional stable attribution for $kind decisions", (input) => {
    const response = (decision: Record<string, unknown>) => input.kind === "text"
      ? { ok: true, decisions: [{ i: 0, ...decision }] }
      : { ok: true, decision };
    expect(validateNativeResponse(input, response({ block: true }))).toBe(true);
    expect(validateNativeResponse(input, response({ block: true, ruleId: "rule-123", rule: "Current display label" }))).toBe(true);
    expect(validateNativeResponse(input, response({ block: true, ruleId: "a".repeat(MAX_RULE_ID_LENGTH) }))).toBe(true);
    expect(validateNativeResponse(input, response({ block: false, ruleId: "rule-123" }))).toBe(true);
  });

  it.each(responseInputs)("rejects invalid stable attribution in $kind decisions", (input) => {
    for (const ruleId of ["", "a".repeat(MAX_RULE_ID_LENGTH + 1), null, 7, {}, []]) {
      const decision = { block: true, ruleId };
      const response = input.kind === "text" ? { ok: true, decisions: [{ i: 0, ...decision }] } : { ok: true, decision };
      expect(validateNativeResponse(input, response), `invalid ruleId ${JSON.stringify(ruleId)}`).toBe(false);
    }
  });
});
