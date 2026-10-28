import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { SETTINGS_KEY } from "../core/settings";
import { fetchImageDataUrl, clearMemory, loadMemory, refreshSpoilerMemory } from "../services/memory-service";
import { summarizeMemory } from "../core/memory";
import { LeaseQueue } from "../core/lease-queue";
import { loadSettings, loadStatus } from "../platform/storage";
import { installNativeAiBroker } from "../platform/native-ai-broker";

const MEMORY_ALARM = "spoilt.memory.refresh";
const aiLeases = new LeaseQueue();
const aiLeaseTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const AI_LEASE_MAX_MS = 180_000;

export default defineBackground(() => {
  installNativeAiBroker();
  browser.runtime.onInstalled.addListener(() => { void ensureMemoryAlarm(); });
  browser.runtime.onStartup.addListener(() => { void ensureMemoryAlarm(); });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === MEMORY_ALARM) void refreshSpoilerMemory("alarm");
    else if (/^spoilt\.(prefetch|page)\./.test(alarm.name)) void expirePrefetchAnalysis(alarm.name);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[SETTINGS_KEY]) void ensureMemoryAlarm();
  });
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status !== "loading") return;
    const leaseId = aiLeases.releaseOwner(`tab:${tabId}`);
    if (leaseId) clearAiLeaseTimeout(leaseId);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    void browser.storage.session.remove(`spoilt.prefetch.${tabId}`);
    void browser.alarms.clear(`spoilt.prefetch.${tabId}`);
    void browser.storage.session.remove(`spoilt.page.${tabId}`);
    void browser.alarms.clear(`spoilt.page.${tabId}`);
    const leaseId = aiLeases.releaseOwner(`tab:${tabId}`);
    if (leaseId) clearAiLeaseTimeout(leaseId);
  });
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!isMessage(message)) return undefined;
    if (message.type === "savePrefetchAnalysis") return savePrefetchAnalysis(message.analysis, sender);
    if (message.type === "savePageAnalysis") return savePrefetchAnalysis(message.analysis, sender, true);
    if (message.type === "getPrefetchAnalysis") return getPrefetchAnalysis(sender);
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
  analysis?: unknown;
} {
  return Boolean(value) && typeof value === "object" && (value as { scope?: string }).scope === "spoilt";
}

// Session storage is accessible only to trusted extension contexts, and is cleared on browser exit.
async function savePrefetchAnalysis(value: unknown, sender: Browser.runtime.MessageSender, live = false): Promise<{ ok: boolean }> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0 || !sender.url || !value || typeof value !== "object") return { ok: false };
  const analysis = value as { url?: unknown; createdAt?: unknown; signature?: unknown; matches?: unknown; images?: unknown; kind?: unknown };
  if (typeof analysis.url !== "string" || typeof analysis.signature !== "string"
    || typeof analysis.createdAt !== "number" || !Array.isArray(analysis.matches)
    || !Number.isFinite(analysis.createdAt) || Math.abs(Date.now() - analysis.createdAt) > 60_000
    || analysis.matches.length > 700 || JSON.stringify(value).length > 500_000
    || analysis.matches.some((item) => !validDecision(item, "text"))
    || (analysis.images !== undefined && (!Array.isArray(analysis.images) || analysis.images.length > 300
      || analysis.images.some((item) => !validDecision(item, "url"))))) return { ok: false };
  try {
    const source = new URL(sender.url);
    const target = new URL(analysis.url);
    if (!/^https?:$/.test(target.protocol) || source.origin !== target.origin
      || (live ? target.href !== source.href || analysis.kind !== "live" : target.search || target.hash || analysis.kind !== undefined)) return { ok: false };
  } catch { return { ok: false }; }
  const key = `spoilt.${live ? "page" : "prefetch"}.${tabId}`;
  await browser.storage.session.set({ [key]: analysis });
  await browser.alarms.create(key, { when: Date.now() + 60_000 });
  return { ok: true };
}

async function getPrefetchAnalysis(sender: Browser.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0 || !sender.url) return null;
  const url = new URL(sender.url);
  // Chrome tracks a tab's opener even for links using rel=noopener. Keep reuse
  // limited to the requesting tab and its actual opener, never unrelated tabs.
  const openerId = sender.tab?.openerTabId ?? (await browser.tabs.get(tabId)).openerTabId;
  const keys = [`spoilt.page.${tabId}`, `spoilt.prefetch.${tabId}`];
  if (openerId !== undefined) keys.push(`spoilt.prefetch.${openerId}`);
  const stored = await browser.storage.session.get(keys);
  const results: unknown[] = [];
  for (const key of keys) {
    const analysis = stored[key] as { url?: string; createdAt?: number } | undefined;
    if (!analysis || typeof analysis.createdAt !== "number" || Date.now() - analysis.createdAt > 60_000 || Date.now() < analysis.createdAt) continue;
    if (analysis.url === url.href) results.push(analysis);
  }
  // Let the content script select using its current rule/memory signature. An
  // older live entry must not shadow a newly prepared entry for the same URL.
  return results;
}

function validDecision(value: unknown, field: "text" | "url"): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const match = item.match as Record<string, unknown> | undefined;
  return typeof item[field] === "string" && (item[field] as string).length <= 4000
    && (item.ai === undefined || typeof item.ai === "boolean")
    && (field !== "url" || typeof item.alt === "string")
    && Boolean(match && typeof match.ruleId === "string" && typeof match.ruleName === "string" && typeof match.reason === "string");
}

async function expirePrefetchAnalysis(key: string): Promise<void> {
  const analysis = (await browser.storage.session.get(key))[key] as { createdAt?: number } | undefined;
  if (!analysis || typeof analysis.createdAt !== "number") return;
  const remaining = analysis.createdAt + 60_000 - Date.now();
  if (remaining <= 0) await browser.storage.session.remove(key);
  else await browser.alarms.create(key, { when: Date.now() + remaining });
}
