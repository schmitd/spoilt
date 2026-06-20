import { browser } from "wxt/browser";
import { DEFAULT_SETTINGS, normalizeSettings, SETTINGS_KEY } from "../core/settings";
import { EMPTY_STATUS, normalizeStatus, STATUS_KEY } from "../core/status";
import type { ExtensionStatus, Settings } from "../core/types";

export async function loadSettings(): Promise<Settings> {
  const result = await browser.storage.sync.get(SETTINGS_KEY);
  const settings = normalizeSettings(result[SETTINGS_KEY]);
  if (!result[SETTINGS_KEY]) await browser.storage.sync.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  return settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.sync.set({ [SETTINGS_KEY]: normalizeSettings(settings) });
}

export async function loadStatus(): Promise<ExtensionStatus> {
  const result = await browser.storage.local.get(STATUS_KEY);
  return normalizeStatus(result[STATUS_KEY] ?? EMPTY_STATUS);
}

export async function updateStatus(patch: Partial<ExtensionStatus>): Promise<ExtensionStatus> {
  const status = { ...await loadStatus(), ...patch, updatedAt: new Date().toISOString() };
  await browser.storage.local.set({ [STATUS_KEY]: status });
  return status;
}

export function watchSettings(callback: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, Browser.storage.StorageChange>, areaName: string) => {
    if (areaName === "sync" && changes[SETTINGS_KEY]) {
      callback(normalizeSettings(changes[SETTINGS_KEY].newValue));
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
