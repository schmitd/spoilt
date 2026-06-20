import { describe, expect, it } from "vitest";
import { parseModelJson } from "./model-json";

describe("model JSON parsing", () => {
  it("accepts fenced and prefixed JSON", () => {
    expect(parseModelJson<{ block: boolean }>('```json\n{"block":true}\n```').block).toBe(true);
    expect(parseModelJson<{ block: boolean }>('Result: {"block":false} trailing').block).toBe(false);
  });

  it("rejects malformed object output", () => {
    expect(() => parseModelJson("{broken")).toThrow(SyntaxError);
  });
});
