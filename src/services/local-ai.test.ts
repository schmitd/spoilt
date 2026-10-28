import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import { prepareLocalAi } from "./local-ai";

const { getContexts, createWindow, getWindow, updateWindow, createTab, updateTab, queryTabs, getAllWindows, windowApiState } = vi.hoisted(() => ({
  getContexts: vi.fn(), createWindow: vi.fn(), getWindow: vi.fn(), updateWindow: vi.fn(),
  createTab: vi.fn(), updateTab: vi.fn(), queryTabs: vi.fn(), getAllWindows: vi.fn(),
  windowApiState: { unavailable: false },
}));
vi.mock("wxt/browser", () => ({ browser: {
  runtime: { getURL: (path: string) => `chrome-extension://extension${path}`, getContexts },
  tabs: { create: createTab, update: updateTab, query: queryTabs },
  get windows() { return windowApiState.unavailable ? undefined
    : { create: createWindow, get: getWindow, update: updateWindow, getAll: getAllWindows }; },
} }));

beforeEach(() => {
  vi.clearAllMocks();
  windowApiState.unavailable = false;
  getContexts.mockReset().mockResolvedValue([]);
  createWindow.mockReset().mockResolvedValue({ id: 8 });
  getWindow.mockReset().mockResolvedValue({ id: 8, type: "popup", state: "normal" });
  updateWindow.mockReset().mockResolvedValue({ id: 8 });
  updateTab.mockReset().mockResolvedValue({ id: 42 });
});
afterEach(() => vi.unstubAllGlobals());

describe("explicit analysis window action", () => {
  it("opens a compact analysis window only on the explicit action without accessing unrelated tabs or models", async () => {
    const model = { availability: vi.fn(), create: vi.fn() };
    vi.stubGlobal("LanguageModel", model);
    expect(createWindow).not.toHaveBeenCalled();
    await prepareLocalAi(DEFAULT_SETTINGS);
    expect(getContexts).toHaveBeenCalledWith({ contextTypes: ["TAB"], documentUrls: ["chrome-extension://extension/analysis.html"] });
    expect(createWindow).toHaveBeenCalledExactlyOnceWith({
      url: "chrome-extension://extension/analysis.html", type: "popup", width: 480, height: 680, focused: true,
    });
    expect(createTab).not.toHaveBeenCalled();
    expect(queryTabs).not.toHaveBeenCalled();
    expect(getAllWindows).not.toHaveBeenCalled();
    expect(getWindow).not.toHaveBeenCalled();
    expect(updateWindow).not.toHaveBeenCalled();
    expect(model.availability).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
  });

  it.each(["normal", "maximized", "fullscreen"])("focuses its existing popup and preserves its %s state", async (state) => {
    getContexts.mockResolvedValue([{ tabId: 42, windowId: 8 }]);
    getWindow.mockResolvedValue({ id: 8, type: "popup", state });
    await prepareLocalAi(DEFAULT_SETTINGS);
    expect(getWindow).toHaveBeenCalledExactlyOnceWith(8);
    expect(updateTab).toHaveBeenCalledExactlyOnceWith(42, { active: true });
    expect(updateWindow).toHaveBeenCalledExactlyOnceWith(8, { focused: true });
    expect(createWindow).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  it("restores only its own minimized popup when the user asks to Prepare again", async () => {
    getContexts.mockResolvedValue([{ tabId: 42, windowId: 8 }]);
    getWindow.mockResolvedValue({ id: 8, type: "popup", state: "minimized" });
    await prepareLocalAi(DEFAULT_SETTINGS);
    expect(updateWindow).toHaveBeenCalledExactlyOnceWith(8, { state: "normal", focused: true });
    expect(createWindow).not.toHaveBeenCalled();
  });

  it.each(["normal", "minimized"])("moves only the legacy analysis tab out of its %s browsing window", async (state) => {
    getContexts.mockResolvedValue([{ tabId: 42, windowId: 8 }]);
    getWindow.mockResolvedValue({ id: 8, type: "normal", state });
    await prepareLocalAi(DEFAULT_SETTINGS);
    expect(createWindow).toHaveBeenCalledExactlyOnceWith({ tabId: 42, type: "popup", width: 480, height: 680, focused: true });
    expect(updateTab).not.toHaveBeenCalled();
    expect(updateWindow).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
    expect(queryTabs).not.toHaveBeenCalled();
    expect(getAllWindows).not.toHaveBeenCalled();
  });

  it("migrates a single exact analysis tab when multiple legacy contexts exist", async () => {
    getContexts.mockResolvedValue([{ tabId: 41, windowId: 7 }, { tabId: 42, windowId: 8 }]);
    getWindow.mockResolvedValue({ type: "normal", state: "normal" });
    await prepareLocalAi(DEFAULT_SETTINGS);
    expect(createWindow).toHaveBeenCalledExactlyOnceWith({ tabId: 41, type: "popup", width: 480, height: 680, focused: true });
    expect(getWindow.mock.calls).toEqual([[7], [8]]);
    expect(updateTab).not.toHaveBeenCalled();
    expect(updateWindow).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
    expect(queryTabs).not.toHaveBeenCalled();
    expect(getAllWindows).not.toHaveBeenCalled();
  });

  it("prefers an existing dedicated popup over a legacy normal-window analysis tab", async () => {
    getContexts.mockResolvedValue([{ tabId: 41, windowId: 7 }, { tabId: 42, windowId: 8 }]);
    getWindow.mockResolvedValueOnce({ id: 7, type: "normal", state: "normal" });
    await prepareLocalAi(DEFAULT_SETTINGS);
    expect(updateTab).toHaveBeenCalledExactlyOnceWith(42, { active: true });
    expect(updateWindow).toHaveBeenCalledExactlyOnceWith(8, { focused: true });
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("ignores non-tab contexts without looking up a window", async () => {
    getContexts.mockResolvedValue([{ tabId: -1, windowId: -1 }]);
    await prepareLocalAi(DEFAULT_SETTINGS);
    expect(getWindow).not.toHaveBeenCalled();
    expect(createWindow).toHaveBeenCalledOnce();
  });

  it("reports a local error when Chrome cannot create an analysis window", async () => {
    createWindow.mockRejectedValue(new Error("Browser detail"));
    await expect(prepareLocalAi(DEFAULT_SETTINGS)).rejects.toThrow("Spoilt could not open its analysis window. Choose Prepare again to retry.");
    expect(createTab).not.toHaveBeenCalled();
  });

  it("reports a failed legacy migration without opening a replacement or modifying the browsing window", async () => {
    getContexts.mockResolvedValue([{ tabId: 42, windowId: 8 }]);
    getWindow.mockResolvedValue({ id: 8, type: "normal", state: "normal" });
    createWindow.mockRejectedValue(new Error("Migration failed"));
    await expect(prepareLocalAi(DEFAULT_SETTINGS)).rejects.toThrow("Spoilt could not open its analysis window");
    expect(createWindow).toHaveBeenCalledExactlyOnceWith({ tabId: 42, type: "popup", width: 480, height: 680, focused: true });
    expect(updateTab).not.toHaveBeenCalled();
    expect(updateWindow).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  it("reports an unavailable windows API without silently opening a tab", async () => {
    windowApiState.unavailable = true;
    await expect(prepareLocalAi(DEFAULT_SETTINGS)).rejects.toThrow("Spoilt could not open its analysis window");
    expect(createWindow).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  it("reports a closed or inaccessible existing window without opening a duplicate host", async () => {
    getContexts.mockResolvedValue([{ tabId: 42, windowId: 8 }]);
    getWindow.mockRejectedValue(new Error("Window closed"));
    await expect(prepareLocalAi(DEFAULT_SETTINGS)).rejects.toThrow("Spoilt could not open its analysis window");
    expect(createWindow).not.toHaveBeenCalled();
    expect(updateWindow).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  it("reports a failed popup restoration without opening another window", async () => {
    getContexts.mockResolvedValue([{ tabId: 42, windowId: 8 }]);
    updateWindow.mockRejectedValue(new Error("Restoration failed"));
    await expect(prepareLocalAi(DEFAULT_SETTINGS)).rejects.toThrow("Spoilt could not open its analysis window");
    expect(createWindow).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });
});
