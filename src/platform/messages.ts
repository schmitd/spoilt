import { browser } from "wxt/browser";
import type { ExtensionStatus, MemorySummary } from "../core/types";

export type ContentCommand = "scan" | "status" | "resetAI" | "clear";

interface ContentResponse {
  ok: boolean;
  status?: ExtensionStatus;
  error?: string;
}

export async function sendToActiveTab(type: ContentCommand): Promise<ContentResponse> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "No active tab is available." };
  return browser.tabs.sendMessage(tab.id, { scope: "spoilt", type }) as Promise<ContentResponse>;
}

export async function refreshMemory(): Promise<MemorySummary> {
  const response = await browser.runtime.sendMessage({ scope: "spoilt", type: "refreshMemory" }) as {
    ok: boolean;
    result?: MemorySummary;
    error?: string;
  };
  if (!response.ok || !response.result) throw new Error(response.error || "Recent spoiler knowledge could not be refreshed.");
  return response.result;
}

export async function getMemoryStatus(): Promise<MemorySummary> {
  const response = await browser.runtime.sendMessage({ scope: "spoilt", type: "memoryStatus" }) as {
    ok: boolean;
    memory?: MemorySummary;
    error?: string;
  };
  if (!response.ok || !response.memory) throw new Error(response.error || "Recent spoiler knowledge is not available yet.");
  return response.memory;
}
