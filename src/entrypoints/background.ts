import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { SETTINGS_KEY } from "../core/settings";
import { fetchImageDataUrl, clearMemory, loadMemory, refreshSpoilerMemory } from "../services/memory-service";
import { summarizeMemory } from "../core/memory";
import { LeaseQueue } from "../core/lease-queue";
import { loadSettings, loadStatus } from "../platform/storage";

const MEMORY_ALARM = "spoilt.memory.refresh";
const aiLeases = new LeaseQueue();
const aiLeaseTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const AI_LEASE_MAX_MS = 180_000;

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => { void ensureMemoryAlarm(); });
  browser.runtime.onStartup.addListener(() => { void ensureMemoryAlarm(); });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === MEMORY_ALARM) void refreshSpoilerMemory("alarm");
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[SETTINGS_KEY]) void ensureMemoryAlarm();
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    const leaseId = aiLeases.releaseOwner(`tab:${tabId}`);
    if (leaseId) clearAiLeaseTimeout(leaseId);
  });
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!isMessage(message)) return undefined;
    if (message.type === "acquireAiLease" && typeof message.requestId === "string") {
      return acquireAiLease(message.requestId, message.kind, sender);
    }
    if (message.type === "releaseAiLease" && typeof message.leaseId === "string") {
      return { ok: releaseAiLease(message.leaseId) };
    }
    if (message.type === "cancelAiLease" && typeof message.requestId === "string") {
      const result = aiLeases.cancel(message.requestId);
      if (result.leaseId) clearAiLeaseTimeout(result.leaseId);
      return { ok: result.cancelled };
    }
    if (message.type === "refreshMemory") return respond(() => refreshSpoilerMemory("manual"), "result");
    if (message.type === "memoryStatus") return respond(async () => summarizeMemory(await loadMemory()), "memory");
    if (message.type === "clearMemory") return respond(async () => { await clearMemory(); return true; }, "result");
    if (message.type === "fetchImageDataUrl" && typeof message.url === "string") {
      return respond(() => fetchImageDataUrl(message.url as string), "result");
    }
    return undefined;
  });
  void loadStatus();
  void ensureMemoryAlarm();
});

async function acquireAiLease(
  requestId: string,
  kind: string | undefined,
  sender: Browser.runtime.MessageSender,
): Promise<{ ok: true; leaseId: string }> {
  const ownerId = sender.tab?.id === undefined
    ? `extension:${sender.documentId || sender.url || kind || "unknown"}`
    : `tab:${sender.tab.id}`;
  const leaseId = await aiLeases.acquire(requestId, ownerId);
  aiLeaseTimeouts.set(leaseId, setTimeout(() => releaseAiLease(leaseId), AI_LEASE_MAX_MS));
  return { ok: true, leaseId };
}

function releaseAiLease(leaseId: string): boolean {
  clearAiLeaseTimeout(leaseId);
  return aiLeases.release(leaseId);
}

function clearAiLeaseTimeout(leaseId: string): void {
  const timeout = aiLeaseTimeouts.get(leaseId);
  if (timeout) clearTimeout(timeout);
  aiLeaseTimeouts.delete(leaseId);
}

async function ensureMemoryAlarm(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.memoryEnabled) {
    await browser.alarms.clear(MEMORY_ALARM);
    return;
  }
  const periodInMinutes = Math.max(30, settings.memoryRefreshHours * 60);
  const existing = await browser.alarms.get(MEMORY_ALARM);
  if (!existing || existing.periodInMinutes !== periodInMinutes) {
    await browser.alarms.create(MEMORY_ALARM, { delayInMinutes: 2, periodInMinutes });
  }
}

async function respond<T, K extends string>(operation: () => Promise<T>, key: K): Promise<{ ok: true } & Record<K, T> | { ok: false; error: string }> {
  try {
    return { ok: true, [key]: await operation() } as { ok: true } & Record<K, T>;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isMessage(value: unknown): value is {
  scope: "spoilt";
  type: string;
  url?: string;
  requestId?: string;
  leaseId?: string;
  kind?: string;
} {
  return Boolean(value) && typeof value === "object" && (value as { scope?: string }).scope === "spoilt";
}
