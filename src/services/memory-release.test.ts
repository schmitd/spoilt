import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../core/settings";
import { loadSettings } from "../platform/storage";
import { loadMemory, refreshSpoilerMemory } from "./memory-service";

vi.mock("wxt/browser", () => ({ browser: {} }));
vi.mock("../platform/storage", () => ({ loadSettings: vi.fn(), updateStatus: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

describe("public-news release gate", () => {
  it("does not read retained legacy news into production matching", async () => {
    expect(await loadMemory()).toMatchObject({ enabled: false, entries: [], imageExamples: [] });
  });

  it("defaults off, even with a legacy synced true value and after saving other settings", () => {
    expect(DEFAULT_SETTINGS.memoryEnabled).toBe(false);
    expect(normalizeSettings(undefined).memoryEnabled).toBe(false);
    const legacy = normalizeSettings({ ...DEFAULT_SETTINGS, memoryEnabled: true });
    expect(legacy.memoryEnabled).toBe(false);
    expect(normalizeSettings({ ...legacy, enabled: false }).memoryEnabled).toBe(false);
  });

  it.each(["manual", "alarm"] as const)("never fetches for a %s refresh, even if settings still report true", async (reason) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.mocked(loadSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, memoryEnabled: true });
    expect(await refreshSpoilerMemory(reason)).toMatchObject({ enabled: false, entryCount: 0, imageExampleCount: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
