import { describe, expect, it } from "vitest";
import { normalizeStatus } from "./status";

describe("status", () => {
  it("clears legacy transient model cancellation errors", () => {
    expect(normalizeStatus({
      lastError: "Text analysis paused: AbortError: The request was cancelled.",
    }).lastError).toBe("");
    expect(normalizeStatus({
      lastError: "InvalidStateError: The device is unable to create a session to run the model.",
    }).lastError).toBe("");
  });

  it("preserves actionable errors", () => {
    expect(normalizeStatus({ lastError: "The content script could not start." }).lastError)
      .toBe("The content script could not start.");
  });
});
