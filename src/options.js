const SETTINGS_KEY = "spoilt.settings";

const form = document.querySelector("#settings-form");
const rulesRoot = document.querySelector("#rules");
const template = document.querySelector("#rule-template");
const statusEl = document.querySelector("#save-status");

let settings = DEFAULT_SETTINGS;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  settings = await loadSettings();
  renderSettings(settings);
  document.querySelector("#add-rule").addEventListener("click", () => addRuleCard({ id: crypto.randomUUID(), name: "", description: "", keywords: [] }));
  document.querySelector("#restore-defaults").addEventListener("click", () => renderSettings(DEFAULT_SETTINGS));
  form.addEventListener("submit", saveSettings);
}

async function loadSettings() {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  const loaded = normalizeSettings(result[SETTINGS_KEY]);
  if (!result[SETTINGS_KEY]) await chrome.storage.sync.set({ [SETTINGS_KEY]: loaded });
  return loaded;
}

function renderSettings(next) {
  settings = normalizeSettings(next);
  for (const key of ["enabled", "useLocalAI", "useVision", "scanText", "scanImages", "memoryEnabled"]) {
    document.querySelector(`#${key}`).checked = Boolean(settings[key]);
  }
  document.querySelector("#strictness").value = settings.strictness;
  document.querySelector("#memoryRefreshHours").value = settings.memoryRefreshHours;
  document.querySelector("#memoryMaxEntriesPerRule").value = settings.memoryMaxEntriesPerRule;
  document.querySelector("#memoryMaxImageExamplesPerRule").value = settings.memoryMaxImageExamplesPerRule;
  rulesRoot.textContent = "";
  for (const rule of settings.rules) addRuleCard(rule);
  statusEl.textContent = "";
  refreshMemoryStatus();
}

function addRuleCard(rule) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.ruleId = rule.id || crypto.randomUUID();
  node.querySelector(".rule-name").value = rule.name || "";
  node.querySelector(".rule-description").value = rule.description || "";
  node.querySelector(".rule-keywords").value = (rule.keywords || []).join("\n");
  node.querySelector(".remove-rule").addEventListener("click", () => {
    if (rulesRoot.children.length > 1) node.remove();
  });
  rulesRoot.appendChild(node);
}

async function saveSettings(event) {
  event.preventDefault();
  const next = normalizeSettings({
    enabled: document.querySelector("#enabled").checked,
    useLocalAI: document.querySelector("#useLocalAI").checked,
    useVision: document.querySelector("#useVision").checked,
    scanText: document.querySelector("#scanText").checked,
    scanImages: document.querySelector("#scanImages").checked,
    memoryEnabled: document.querySelector("#memoryEnabled").checked,
    strictness: document.querySelector("#strictness").value,
    memoryRefreshHours: document.querySelector("#memoryRefreshHours").value,
    memoryMaxEntriesPerRule: document.querySelector("#memoryMaxEntriesPerRule").value,
    memoryMaxImageExamplesPerRule: document.querySelector("#memoryMaxImageExamplesPerRule").value,
    maxTextNodesPerScan: settings.maxTextNodesPerScan,
    maxImagesPerScan: settings.maxImagesPerScan,
    rules: Array.from(rulesRoot.querySelectorAll(".rule-card")).map((card, index) => ({
      id: card.dataset.ruleId || `rule-${index}`,
      name: card.querySelector(".rule-name").value,
      description: card.querySelector(".rule-description").value,
      keywords: parseKeywordInput(card.querySelector(".rule-keywords").value)
    }))
  });
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  settings = next;
  statusEl.textContent = "Saved. Existing tabs update on the next scan or reload.";
  setTimeout(() => { statusEl.textContent = ""; }, 4000);
}

async function refreshMemoryStatus() {
  const status = document.querySelector("#memory-status");
  if (!status) return;
  try {
    const response = await chrome.runtime.sendMessage({ scope: "spoilt", type: "memoryStatus" });
    if (!response || !response.ok) {
      status.textContent = "Memory status is not available yet.";
      return;
    }
    const memory = response.memory;
    const last = memory.lastUpdatedAt ? new Date(memory.lastUpdatedAt).toLocaleString() : "never";
    status.textContent = `${memory.entryCount} details and ${memory.imageExampleCount} image examples stored. Last refresh: ${last}.`;
  } catch (_error) {
    status.textContent = "Memory status appears after the extension service worker starts.";
  }
}
