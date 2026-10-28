import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { start } = vi.hoisted(() => ({ start: vi.fn<() => Promise<void>>() }));
vi.mock("./controller", () => ({ ContentController: class { start = start; } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("defineContentScript", (config: unknown) => config);
  document.body.innerHTML = "<p>Ordinary content</p>";
  start.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-spoilt-preparing");
  document.body.innerHTML = "";
});

async function boot() {
  const entry = await import("../entrypoints/content");
  (entry.default as unknown as { main: () => void }).main();
}

describe("early protection deadline", () => {
  it("releases a stalled startup after 500 ms with an honest dismissible notice", async () => {
    let ready!: () => void;
    start.mockImplementation(() => new Promise<void>(resolve => { ready = resolve; }));
    await boot();
    expect(document.documentElement.hasAttribute("data-spoilt-preparing")).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(document.documentElement.hasAttribute("data-spoilt-preparing")).toBe(false);
    expect(document.querySelector("[role=status]")?.textContent).toContain("Unchecked content may be visible");
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector("[data-spoilt-ui]")).toBeNull();
  });

  it("releases the cover and explains when startup fails", async () => {
    start.mockRejectedValue(new Error("Storage unavailable"));
    await boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.documentElement.hasAttribute("data-spoilt-preparing")).toBe(false);
    expect(document.querySelector("[role=status]")?.textContent).toContain("could not start protection");
    document.querySelector<HTMLButtonElement>("[data-spoilt-ui] button")!.click();
    expect(document.querySelector("[data-spoilt-ui]")).toBeNull();
  });
});
