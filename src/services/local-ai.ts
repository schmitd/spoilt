import { browser } from "wxt/browser";
import type { Settings } from "../core/types";

// Called only by the popup's explicit Prepare action. Download consent happens in the tab.
export async function prepareLocalAi(_settings: Settings): Promise<void> {
  const url = browser.runtime.getURL("/analysis.html");
  const contexts = await browser.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
  const existing = contexts.find((context) => context.tabId >= 0);
  if (existing) {
    await browser.tabs.update(existing.tabId, { active: true });
    return;
  }
  await browser.tabs.create({ url });
}
