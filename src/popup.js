const SETTINGS_KEY = "spoilt.settings";
const STATUS_KEY = "spoilt.status";

const enabledEl = document.querySelector("#enabled");
const errorEl = document.querySelector("#last-error");

let settings = DEFAULT_SETTINGS;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  settings = await loadSettings();
  enabledEl.checked = Boolean(settings.enabled);
  enabledEl.addEventListener("change", toggleEnabled);
  document.querySelector("#rescan").addEventListener("click", () => sendToActiveTab({ type: "scan" }));
  document.querySelector("#clear").addEventListener("click", () => sendToActiveTab({ type: "clear" }));
  document.querySelector("#options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  await refreshStatus();
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

function renderStatus(status) {
  const counters = status.counters || {};
  document.querySelector("#text-count").textContent = String(counters.text || 0);
  document.querySelector("#image-count").textContent = String(counters.images || 0);
  document.querySelector("#ai-text").textContent = status.aiText || "unknown";
  document.querySelector("#ai-vision").textContent = status.aiVision || "fallback";
  if (status.lastError) showError(status.lastError);
}

function showError(message) {
  errorEl.hidden = false;
  errorEl.textContent = message;
}
