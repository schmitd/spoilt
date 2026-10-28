import { browser } from "wxt/browser";
import type { Settings } from "../core/types";

// Called only by the toolbar popup's explicit Prepare action. Model consent stays in the analysis window.
export async function prepareLocalAi(_settings: Settings): Promise<void> {
  try {
    const url = browser.runtime.getURL("/analysis.html");
    const contexts = await browser.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
    let legacyTabId: number | undefined;
    for (const context of contexts) {
      if (context.tabId < 0 || context.windowId < 0) continue;
      const window = await browser.windows.get(context.windowId);
      if (window.type === "popup") {
        await browser.tabs.update(context.tabId, { active: true });
        await browser.windows.update(context.windowId, window.state === "minimized"
          ? { state: "normal", focused: true } : { focused: true });
        return;
      }
      legacyTabId ??= context.tabId;
    }
    // Move only the older analysis tab, preserving its document and live host.
    if (legacyTabId !== undefined) {
      await browser.windows.create({ tabId: legacyTabId, type: "popup", width: 480, height: 680, focused: true });
      return;
    }
    await browser.windows.create({ url, type: "popup", width: 480, height: 680, focused: true });
  } catch {
    throw new Error("Spoilt could not open its analysis window. Choose Prepare again to retry.");
  }
}
