import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import { prepareLocalAi } from "./local-ai";

const { getContexts, create, update } = vi.hoisted(() => ({
  getContexts: vi.fn(), create: vi.fn(), update: vi.fn(),
}));
vi.mock("wxt/browser", () => ({ browser: {
  runtime: { getURL: (path: string) => `chrome-extension://extension${path}`, getContexts },
  tabs: { create, update },
} }));

beforeEach(() => { getContexts.mockReset().mockResolvedValue([]); create.mockClear(); update.mockClear(); });

describe("explicit analysis tab action", () => {
  it("opens the extension tab without accessing unrelated tabs or creating a model", async () => {
    await prepareLocalAi(DEFAULT_SETTINGS);
    expect(getContexts).toHaveBeenCalledWith({ contextTypes: ["TAB"], documentUrls: ["chrome-extension://extension/analysis.html"] });
    expect(create).toHaveBeenCalledWith({ url: "chrome-extension://extension/analysis.html" });
  });
  it("focuses an existing analysis context without opening a duplicate", async () => {
    getContexts.mockResolvedValue([{ tabId: 42 }]);
    await prepareLocalAi(DEFAULT_SETTINGS);
    expect(update).toHaveBeenCalledWith(42, { active: true });
    expect(create).not.toHaveBeenCalled();
  });
});
