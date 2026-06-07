const SETTINGS_KEY = "spoilt.settings";
const STATUS_KEY = "spoilt.status";
const MODEL_PREPARE_TIMEOUT_MS = 120000;

const enabledEl = document.querySelector("#enabled");
const errorEl = document.querySelector("#last-error");
const aiReasonEl = document.querySelector("#ai-reason");

let settings = DEFAULT_SETTINGS;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  settings = await loadSettings();
  enabledEl.checked = Boolean(settings.enabled);
  enabledEl.addEventListener("change", toggleEnabled);
  document.querySelector("#prepare-ai").addEventListener("click", prepareLocalAI);
  document.querySelector("#refresh-memory").addEventListener("click", refreshMemory);
  document.querySelector("#rescan").addEventListener("click", () => sendToActiveTab({ type: "scan" }));
  document.querySelector("#clear").addEventListener("click", () => sendToActiveTab({ type: "clear" }));
  document.querySelector("#options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  await refreshStatus();
  await refreshMemoryStatus();
}

async function loadSettings() {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  const loaded = normalizeSettings(result[SETTINGS_KEY]);
  if (!result[SETTINGS_KEY]) await chrome.storage.sync.set({ [SETTINGS_KEY]: loaded });
  return loaded;
}

async function toggleEnabled() {
  settings = normalizeSettings({ ...settings, enabled: enabledEl.checked });
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  await sendToActiveTab({ type: "scan" });
}

async function refreshStatus() {
  const result = await chrome.storage.local.get(STATUS_KEY);
  renderStatus(result[STATUS_KEY] || {});
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { scope: "spoilt", ...message });
    renderStatus(response && response.status ? response.status : {});
  } catch (error) {
    showError("This page cannot be scanned. Try a normal webpage and reload it after installing Spoilt.");
  }
}

async function prepareLocalAI() {
  clearError();
  await updateStatus({ aiText: "checking", aiVision: settings.useVision ? "checking" : "fallback", aiReason: "Checking Chrome local AI support." });
  renderStatus((await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] || {});
  if (typeof LanguageModel === "undefined") {
    await updateStatus({
      aiText: "unavailable",
      aiVision: "fallback",
      aiReason: "LanguageModel is not exposed in this Chrome version/profile. Check Chrome 138+ and chrome://flags for Prompt API support."
    });
    await refreshStatus();
    return;
  }

  const textPrepared = await prepareSession({
    label: "text",
    statusKey: "aiText",
    options: {
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
      initialPrompts: [{ role: "system", content: "You classify text against user-defined content blocking rules." }]
    }
  });

  if (settings.useVision) {
    await prepareSession({
      label: "vision",
      statusKey: "aiVision",
      fallbackStatus: "fallback",
      options: {
        expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
        initialPrompts: [{ role: "system", content: "You classify images against user-defined content blocking rules." }]
      }
    });
  } else {
    await updateStatus({ aiVision: "fallback" });
  }

  await sendToActiveTab({ type: "resetAI" });
  if (textPrepared) await sendToActiveTab({ type: "scan" });
  await refreshStatus();
}

async function refreshMemory() {
  clearError();
  await updateStatus({ aiReason: "Refreshing spoiler memory from recent web results." });
  await refreshStatus();
  try {
    const response = await chrome.runtime.sendMessage({ scope: "spoilt", type: "refreshMemory" });
    if (!response || !response.ok) throw new Error(response && response.error ? response.error : "Memory refresh failed");
    await updateStatus({ aiReason: "Spoiler memory refreshed." });
    await refreshMemoryStatus();
    await sendToActiveTab({ type: "scan" });
  } catch (error) {
    showError(formatError(error));
  }
}

async function refreshMemoryStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ scope: "spoilt", type: "memoryStatus" });
    if (response && response.ok) renderMemoryStatus(response.memory);
  } catch (_error) {
    renderMemoryStatus({});
  }
}

async function prepareSession({ label, statusKey, fallbackStatus = "unavailable", options }) {
  try {
    const availability = await LanguageModel.availability(options);
    await updateStatus({ [statusKey]: availability, aiReason: `${capitalize(label)} model availability: ${availability}.` });
    if (availability === "unavailable") {
      await updateStatus({
        [statusKey]: fallbackStatus,
        aiReason: label === "vision"
          ? "Vision model is unavailable; Spoilt will use title, alt text, captions, and source metadata."
          : "Text model is unavailable; Spoilt will use keywords and description fallback terms."
      });
      return false;
    }

    const session = await withTimeout(LanguageModel.create({
      ...options,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          updateStatus({
            [statusKey]: "downloading",
            aiDownload: event.loaded,
            aiReason: `Downloading ${label} model: ${Math.round(Number(event.loaded || 0) * 100)}%.`
          });
        });
      }
    }), MODEL_PREPARE_TIMEOUT_MS, `${capitalize(label)} model preparation timed out.`);

    if (session && session.destroy) session.destroy();
    await updateStatus({ [statusKey]: "available", aiReason: `${capitalize(label)} model is ready.` });
    return true;
  } catch (error) {
    await updateStatus({
      [statusKey]: fallbackStatus,
      aiReason: `${capitalize(label)} model could not be prepared. ${formatError(error)}`
    });
    return false;
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId = 0;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function updateStatus(patch) {
  const result = await chrome.storage.local.get(STATUS_KEY);
  await chrome.storage.local.set({
    [STATUS_KEY]: {
      ...(result[STATUS_KEY] || {}),
      ...patch,
      updatedAt: new Date().toISOString()
    }
  });
}

function renderStatus(status) {
  const counters = status.counters || {};
  document.querySelector("#text-count").textContent = String(counters.text || 0);
  document.querySelector("#image-count").textContent = String(counters.images || 0);
  document.querySelector("#ai-text").textContent = status.aiText || "unknown";
  document.querySelector("#ai-vision").textContent = status.aiVision || "fallback";
  if (status.memory) renderMemoryStatus(status.memory);
  if (status.aiReason) {
    aiReasonEl.hidden = false;
    aiReasonEl.textContent = status.aiReason;
  } else {
    aiReasonEl.hidden = true;
    aiReasonEl.textContent = "";
  }
  if (status.lastError) {
    showError(status.lastError);
  } else {
    clearError();
  }
}

function renderMemoryStatus(memory) {
  const count = Number(memory && memory.entryCount || 0) + Number(memory && memory.imageExampleCount || 0);
  document.querySelector("#memory-count").textContent = String(count);
  document.querySelector("#memory-last").textContent = memory && memory.lastUpdatedAt ? shortDate(memory.lastUpdatedAt) : "never";
}

function showError(message) {
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = "";
}

function capitalize(value) {
  return String(value || "").charAt(0).toUpperCase() + String(value || "").slice(1);
}

function formatError(error) {
  if (!error) return "Unknown error.";
  return error.name ? `${error.name}: ${error.message || ""}`.trim() : String(error);
}

function shortDate(value) {
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric" }).format(new Date(value));
  } catch (_error) {
    return "recently";
  }
}
