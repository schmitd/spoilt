import { describe, expect, it } from "vitest";
import { MAX_DATA_URL_LENGTH, validateNativeInput, validateNativeResponse } from "./native-ai-protocol";

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
});
