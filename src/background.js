importScripts("shared.js", "memory.js");

const SETTINGS_KEY = "spoilt.settings";
const STATUS_KEY = "spoilt.status";
const MEMORY_ALARM = "spoilt.memory.refresh";
const DEFAULT_REFRESH_HOURS = 12;
const MAX_IMAGE_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 12000;

chrome.runtime.onInstalled.addListener(() => ensureMemoryAlarm());
chrome.runtime.onStartup.addListener(() => ensureMemoryAlarm());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MEMORY_ALARM) refreshMemory({ reason: "alarm" }).catch((error) => setMemoryError(error));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[SETTINGS_KEY]) ensureMemoryAlarm();
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.scope !== "spoilt") return false;
  if (message.type === "refreshMemory") {
    refreshMemory({ reason: "manual" }).then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }
  if (message.type === "memoryStatus") {
    getMemory().then((memory) => sendResponse({ ok: true, memory: summarizeMemory(memory) })).catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }
  if (message.type === "clearMemory") {
    chrome.storage.local.set({ [MEMORY_KEY]: DEFAULT_MEMORY }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }
  if (message.type === "fetchImageDataUrl") {
    fetchImageDataUrl(message.url).then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: formatError(error) }));
    return true;
  }
  return false;
});

ensureMemoryAlarm();

async function ensureMemoryAlarm() {
  const settings = await getSettings();
  if (!settings.memoryEnabled) {
    await chrome.alarms.clear(MEMORY_ALARM);
    return;
  }
  const periodInMinutes = Math.max(30, Number(settings.memoryRefreshHours || DEFAULT_REFRESH_HOURS) * 60);
  const existing = await chrome.alarms.get(MEMORY_ALARM);
  if (!existing || existing.periodInMinutes !== periodInMinutes) {
    await chrome.alarms.create(MEMORY_ALARM, { delayInMinutes: 2, periodInMinutes });
  }
}

async function refreshMemory({ reason }) {
  const settings = await getSettings();
  if (!settings.memoryEnabled) return { skipped: true, reason: "memory disabled" };
  const memory = await getMemory();
  const discoveredAt = new Date().toISOString();
  const updates = { entries: [], imageExamples: [], lastUpdatedAt: discoveredAt, ruleRuns: {} };
  const errors = [];

  for (const rule of settings.rules || []) {
    try {
      const url = buildGoogleNewsRssUrl(rule);
      const response = await fetchWithTimeout(url, { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error(`Search failed ${response.status}`);
      const xml = await response.text();
      const extracted = extractRssItems(xml, rule, discoveredAt);
      updates.entries.push(...extracted.entries);
      updates.imageExamples.push(...extracted.imageExamples);
      updates.ruleRuns[rule.id] = {
        at: discoveredAt,
        reason,
        query: buildRuleSearchQuery(rule),
        resultCount: extracted.entries.length,
        imageExampleCount: extracted.imageExamples.length
      };
    } catch (error) {
      errors.push(`${rule.name || rule.id}: ${formatError(error)}`);
    }
  }

  updates.lastError = errors.join("; ");
  const merged = mergeMemory(memory, updates, {
    maxEntriesPerRule: settings.memoryMaxEntriesPerRule,
    maxImageExamplesPerRule: settings.memoryMaxImageExamplesPerRule
  });
  merged.enabled = Boolean(settings.memoryEnabled);
  await chrome.storage.local.set({ [MEMORY_KEY]: merged });
  await updateStatus({ memory: summarizeMemory(merged) });
  return summarizeMemory(merged);
}

async function fetchImageDataUrl(url) {
  if (!/^https?:\/\//i.test(String(url || "")) && !/^data:/i.test(String(url || ""))) {
    throw new Error("Unsupported image URL");
  }
  if (/^data:/i.test(url)) return { dataUrl: url, contentType: parseDataUrlType(url), bytes: Math.ceil(url.length * 0.75) };
  const response = await fetchWithTimeout(url, { credentials: "omit", cache: "force-cache" });
  if (!response.ok) throw new Error(`Image fetch failed ${response.status}`);
  const contentType = response.headers.get("content-type") || "image/png";
  if (!contentType.startsWith("image/")) throw new Error(`Not an image: ${contentType}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength && contentLength > MAX_IMAGE_BYTES) throw new Error("Image too large for local VLM fetch");
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("Image too large for local VLM fetch");
  return { dataUrl: `data:${contentType};base64,${arrayBufferToBase64(buffer)}`, contentType, bytes: buffer.byteLength };
}

async function getSettings() {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY]);
}

async function getMemory() {
  const result = await chrome.storage.local.get(MEMORY_KEY);
  return normalizeMemory(result[MEMORY_KEY]);
}

async function updateStatus(patch) {
  const result = await chrome.storage.local.get(STATUS_KEY);
  await chrome.storage.local.set({ [STATUS_KEY]: { ...(result[STATUS_KEY] || {}), ...patch, updatedAt: new Date().toISOString() } });
}

async function setMemoryError(error) {
  const memory = await getMemory();
  memory.lastError = formatError(error);
  await chrome.storage.local.set({ [MEMORY_KEY]: memory });
  await updateStatus({ memory: summarizeMemory(memory) });
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...(options || {}), signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function parseDataUrlType(url) {
  const match = String(url || "").match(/^data:([^;,]+)/i);
  return match ? match[1] : "image/png";
}

function formatError(error) {
  if (!error) return "unknown error";
  return error.name ? `${error.name}: ${error.message || ""}`.trim() : String(error);
}
