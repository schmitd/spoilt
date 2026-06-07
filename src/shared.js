const DEFAULT_SETTINGS = {
  enabled: true,
  useLocalAI: true,
  useVision: true,
  scanText: true,
  scanImages: true,
  strictness: "balanced",
  maxTextNodesPerScan: 700,
  maxImagesPerScan: 80,
  rules: [
    {
      id: "plot-spoilers",
      name: "Plot spoilers",
      description: "Story endings, deaths, reveals, twists, episode recaps, leaks, and major plot outcomes.",
      keywords: ["spoiler", "ending", "dies", "death", "killed", "twist", "finale", "post-credit", "leak"]
    }
  ]
};

function normalizeSettings(value) {
  const settings = { ...DEFAULT_SETTINGS, ...(value || {}) };
  settings.rules = Array.isArray(settings.rules) && settings.rules.length > 0
    ? settings.rules.map((rule, index) => ({
      id: String(rule.id || `rule-${index}`),
      name: String(rule.name || `Rule ${index + 1}`).trim(),
      description: String(rule.description || "").trim(),
      keywords: Array.isArray(rule.keywords)
        ? rule.keywords.map((keyword) => String(keyword).trim()).filter(Boolean)
        : []
    })).filter((rule) => rule.name || rule.description || rule.keywords.length)
    : DEFAULT_SETTINGS.rules;
  settings.strictness = ["loose", "balanced", "strict"].includes(settings.strictness)
    ? settings.strictness
    : DEFAULT_SETTINGS.strictness;
  settings.maxTextNodesPerScan = clampNumber(settings.maxTextNodesPerScan, 50, 3000, 700);
  settings.maxImagesPerScan = clampNumber(settings.maxImagesPerScan, 10, 500, 80);
  return settings;
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function parseKeywordInput(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function keywordMatch(text, rules) {
  const source = normalizeComparableText(text);
  if (!source) return null;
  for (const rule of rules || []) {
    for (const keyword of rule.keywords || []) {
      const needle = normalizeComparableText(keyword);
      if (!needle) continue;
      if (source.includes(needle)) {
        return { ruleId: rule.id, ruleName: rule.name, reason: `keyword: ${keyword}` };
      }
    }
  }
  return null;
}

function normalizeComparableText(text) {
  return String(text || "")
    .toLocaleLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\p{L}\p{N}'" ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildRulesSummary(rules) {
  return (rules || []).map((rule, index) => {
    const keywords = (rule.keywords || []).slice(0, 20).join(", ") || "none";
    return `${index + 1}. ${rule.name}: ${rule.description || "No description."} Keywords: ${keywords}`;
  }).join("\n");
}

function strictnessGuidance(strictness) {
  if (strictness === "loose") {
    return "Mask content when it probably relates to any rule, including indirect hints.";
  }
  if (strictness === "strict") {
    return "Mask only when the content clearly and specifically matches a rule.";
  }
  return "Mask when there is a clear semantic match. Do not mask generic unrelated text.";
}

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULT_SETTINGS,
    normalizeSettings,
    parseKeywordInput,
    keywordMatch,
    normalizeComparableText,
    buildRulesSummary,
    strictnessGuidance
  };
}
