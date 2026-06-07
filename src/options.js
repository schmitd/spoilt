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
  for (const key of ["enabled", "useLocalAI", "useVision", "scanText", "scanImages"]) {
    document.querySelector(`#${key}`).checked = Boolean(settings[key]);
  }
  document.querySelector("#strictness").value = settings.strictness;
  rulesRoot.textContent = "";
  for (const rule of settings.rules) addRuleCard(rule);
  statusEl.textContent = "";
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
    strictness: document.querySelector("#strictness").value,
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
