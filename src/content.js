(() => {
  "use strict";

  const SETTINGS_KEY = "spoilt.settings";
  const STATUS_KEY = "spoilt.status";
  const MEMORY_KEY = "spoilt.memory";
  const MASKED_TEXT_CLASS = "spoilt-redacted-text";
  const IMAGE_SHELL_CLASS = "spoilt-image-shell";
  const BACKGROUND_CLASS = "spoilt-background-redacted";
  const SCAN_DEBOUNCE_MS = 900;
  const AI_TEXT_BATCH_SIZE = 18;
  const AI_IMAGE_LIMIT_PER_SCAN = 12;
  const MIN_FALLBACK_TERM_LENGTH = 4;
  const FALLBACK_STOP_WORDS = new Set([
    "about", "after", "also", "and", "are", "avoid", "block", "but", "can", "content", "details",
    "does", "dont", "from", "has", "hide", "include", "includes", "including", "into", "major",
    "not", "online", "other", "should", "show", "that", "the", "their", "them", "then", "there",
    "these", "thing", "this", "those", "through", "when", "where", "with", "what", "will"
  ]);

  const DEFAULT_SETTINGS = {
    enabled: true,
    useLocalAI: true,
    useVision: true,
    scanText: true,
    scanImages: true,
    memoryEnabled: true,
    memoryRefreshHours: 12,
    memoryMaxEntriesPerRule: 16,
    memoryMaxImageExamplesPerRule: 8,
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

  let settings = DEFAULT_SETTINGS;
  let spoilerMemory = typeof normalizeMemory === "function" ? normalizeMemory() : { entries: [], imageExamples: [] };
  let scanTimer = 0;
  let observer = null;
  let textSessionPromise = null;
  let imageSessionPromise = null;
  let currentRun = 0;
  let counters = { text: 0, images: 0, aiText: 0, aiImages: 0 };
  let processedTextNodes = new WeakMap();
  let processedImages = new WeakMap();

  init();

  async function init() {
    settings = await loadSettings();
    spoilerMemory = await loadMemory();
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      handleMessage(message).then(sendResponse).catch((error) => {
        sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
      });
      return true;
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if ((areaName === "sync" || areaName === "local") && changes[SETTINGS_KEY]) {
        settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
        resetAI();
        if (settings.enabled) {
          startObserver();
          scheduleScan();
        } else {
          stopObserver();
          unmaskPage();
          updateStatus({ enabled: false, counters, pendingText: 0, pendingImages: 0 });
        }
      }
      if (areaName === "local" && changes[MEMORY_KEY]) {
        spoilerMemory = typeof normalizeMemory === "function" ? normalizeMemory(changes[MEMORY_KEY].newValue) : changes[MEMORY_KEY].newValue;
        resetProcessedCaches();
        scheduleScan();
      }
    });
    if (settings.enabled) {
      startObserver();
      scheduleScan(50);
    }
  }

  async function handleMessage(message) {
    if (!message || message.scope !== "spoilt") return { ok: false, error: "Unknown message" };
    if (message.type === "scan") {
      settings = await loadSettings();
      spoilerMemory = await loadMemory();
      await scanPage();
      return { ok: true, counters, status: await getStatus() };
    }
    if (message.type === "status") {
      return { ok: true, counters, status: await getStatus() };
    }
    if (message.type === "resetAI") {
      resetAI();
      await updateStatus({ lastError: "" });
      return { ok: true, status: await getStatus() };
    }
    if (message.type === "clear") {
      location.reload();
      return { ok: true };
    }
    return { ok: false, error: "Unsupported message" };
  }

  async function loadSettings() {
    const result = await chrome.storage.sync.get(SETTINGS_KEY);
    if (result && result[SETTINGS_KEY]) return normalizeSettings(result[SETTINGS_KEY]);
    await chrome.storage.sync.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    return DEFAULT_SETTINGS;
  }

  function normalizeSettings(value) {
    const next = { ...DEFAULT_SETTINGS, ...(value || {}) };
    next.rules = Array.isArray(next.rules) && next.rules.length > 0
      ? next.rules.map((rule, index) => ({
        id: String(rule.id || `rule-${index}`),
        name: String(rule.name || `Rule ${index + 1}`).trim(),
        description: String(rule.description || "").trim(),
        keywords: Array.isArray(rule.keywords)
          ? rule.keywords.map((keyword) => String(keyword).trim()).filter(Boolean)
          : []
      })).filter((rule) => rule.name || rule.description || rule.keywords.length)
      : DEFAULT_SETTINGS.rules;
    next.strictness = ["loose", "balanced", "strict"].includes(next.strictness) ? next.strictness : "balanced";
    next.maxTextNodesPerScan = clampNumber(next.maxTextNodesPerScan, 50, 3000, 700);
    next.maxImagesPerScan = clampNumber(next.maxImagesPerScan, 10, 500, 80);
    next.memoryRefreshHours = clampNumber(next.memoryRefreshHours, 1, 168, 12);
    next.memoryMaxEntriesPerRule = clampNumber(next.memoryMaxEntriesPerRule, 4, 80, 16);
    next.memoryMaxImageExamplesPerRule = clampNumber(next.memoryMaxImageExamplesPerRule, 2, 40, 8);
    return next;
  }

  function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, Math.round(numeric)));
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      if (mutations.some(shouldReactToMutation)) {
        scheduleScan();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  function stopObserver() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  function shouldReactToMutation(mutation) {
    if (mutation.target && isSpoiltNode(mutation.target)) return false;
    return mutation.type === "characterData"
      || Array.from(mutation.addedNodes).some((node) => !isSpoiltNode(node));
  }

  function isSpoiltNode(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element && element.closest(`.${MASKED_TEXT_CLASS}, .${IMAGE_SHELL_CLASS}, .${BACKGROUND_CLASS}`));
  }

  function scheduleScan(delay = SCAN_DEBOUNCE_MS) {
    clearTimeout(scanTimer);
    if (!settings.enabled) return;
    scanTimer = window.setTimeout(() => {
      scanPage().catch((error) => updateStatus({ lastError: String(error && error.message ? error.message : error) }));
    }, delay);
  }

  async function scanPage() {
    if (!settings.enabled) {
      unmaskPage();
      await updateStatus({ enabled: false, counters, pendingText: 0, pendingImages: 0 });
      return;
    }
    const runId = ++currentRun;
    const textCandidates = settings.scanText ? collectTextCandidates() : [];
    const imageCandidates = settings.scanImages ? collectImageCandidates() : [];

    const aiTextCandidates = [];
    for (const candidate of textCandidates) {
      const match = directKeywordMatch(candidate.text, settings.rules) || memoryLookup(candidate.text) || descriptionMatch(candidate.text);
      if (match) {
        redactTextNode(candidate.node, match);
      } else {
        aiTextCandidates.push(candidate);
      }
    }

    const aiImageCandidates = [];
    for (const candidate of imageCandidates) {
      const metadataText = getImageMetadata(candidate.element);
      const match = directKeywordMatch(metadataText, settings.rules) || memoryLookup(metadataText) || descriptionMatch(metadataText);
      if (match) {
        redactImage(candidate.element, match);
      } else {
        aiImageCandidates.push({ ...candidate, metadataText });
      }
    }

    await updateStatus({
      enabled: settings.enabled,
      lastScanAt: new Date().toISOString(),
      pendingText: aiTextCandidates.length,
      pendingImages: aiImageCandidates.length,
      counters
    });

    if (settings.useLocalAI && aiTextCandidates.length) {
      await classifyTextWithAI(aiTextCandidates, runId);
    }
    if (settings.useLocalAI && settings.useVision && aiImageCandidates.length) {
      await classifyImagesWithAI(aiImageCandidates.slice(0, AI_IMAGE_LIMIT_PER_SCAN), runId);
    }

    await updateStatus({ counters, pendingText: 0, pendingImages: 0 });
  }

  function collectTextCandidates() {
    const candidates = [];
    const scanSignature = getScanSignature();
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (candidates.length >= settings.maxTextNodesPerScan) return NodeFilter.FILTER_REJECT;
        const text = normalizeWhitespace(node.nodeValue);
        if (!text || text.length < 4) return NodeFilter.FILTER_REJECT;
        if (processedTextNodes.get(node) === `${scanSignature}:${text}`) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT;
        if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node = walker.nextNode();
    while (node && candidates.length < settings.maxTextNodesPerScan) {
      const text = normalizeWhitespace(node.nodeValue);
      processedTextNodes.set(node, `${scanSignature}:${text}`);
      candidates.push({ node, text });
      node = walker.nextNode();
    }
    return candidates;
  }

  function collectImageCandidates() {
    const candidates = [];
    const scanSignature = getScanSignature();
    const elements = Array.from(document.querySelectorAll("img, picture, svg[role='img'], video[poster], canvas"));
    for (const element of elements) {
      if (candidates.length >= settings.maxImagesPerScan) break;
      const metadata = getImageMetadata(element);
      if (processedImages.get(element) === `${scanSignature}:${metadata}` || shouldSkipElement(element) || !isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) continue;
      processedImages.set(element, `${scanSignature}:${metadata}`);
      candidates.push({ element });
    }
    return candidates;
  }

  function shouldSkipElement(element) {
    if (!element || element.closest(`.${MASKED_TEXT_CLASS}, .${IMAGE_SHELL_CLASS}, .${BACKGROUND_CLASS}`)) return true;
    const tagName = element.tagName ? element.tagName.toLowerCase() : "";
    return ["script", "style", "noscript", "template", "textarea", "input", "select", "option", "code", "pre", "kbd", "samp"].includes(tagName)
      || element.isContentEditable
      || element.getAttribute("aria-hidden") === "true";
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function redactTextNode(node, match) {
    if (!node.parentNode || !node.nodeValue) return;
    const span = document.createElement("span");
    span.className = MASKED_TEXT_CLASS;
    span.textContent = node.nodeValue;
    span.title = `Spoilt blocked: ${match.ruleName || "configured content"}`;
    span.setAttribute("aria-label", "Spoilt blocked content");
    span.dataset.spoiltReason = match.reason || "matched configured content";
    node.parentNode.replaceChild(span, node);
    counters.text += 1;
  }

  function redactImage(element, match) {
    if (!element || element.closest(`.${IMAGE_SHELL_CLASS}`)) return;
    const shell = document.createElement("span");
    shell.className = IMAGE_SHELL_CLASS;
    shell.title = `Spoilt blocked image: ${match.ruleName || "configured content"}`;
    shell.setAttribute("aria-label", "Spoilt blocked image");
    shell.dataset.spoiltReason = match.reason || "matched configured content";

    const rect = element.getBoundingClientRect();
    if (rect.width && rect.height) {
      shell.style.width = `${Math.ceil(rect.width)}px`;
      shell.style.height = `${Math.ceil(rect.height)}px`;
    }

    const parent = element.parentNode;
    if (!parent) return;
    parent.insertBefore(shell, element);
    shell.appendChild(element);
    counters.images += 1;
  }

  function unmaskPage() {
    document.querySelectorAll(`.${MASKED_TEXT_CLASS}`).forEach((span) => {
      span.replaceWith(document.createTextNode(span.textContent || ""));
    });
    document.querySelectorAll(`.${IMAGE_SHELL_CLASS}`).forEach((shell) => {
      const parent = shell.parentNode;
      if (!parent) return;
      while (shell.firstChild) parent.insertBefore(shell.firstChild, shell);
      shell.remove();
    });
    document.querySelectorAll(`.${BACKGROUND_CLASS}`).forEach((element) => {
      element.classList.remove(BACKGROUND_CLASS);
      element.removeAttribute("data-spoilt-reason");
    });
    resetProcessedCaches();
    counters = { text: 0, images: 0, aiText: 0, aiImages: 0 };
  }

  function resetProcessedCaches() {
    processedTextNodes = new WeakMap();
    processedImages = new WeakMap();
  }

  async function classifyTextWithAI(candidates, runId) {
    let session = await getTextSession();
    if (!session) return;
    for (let index = 0; index < candidates.length; index += AI_TEXT_BATCH_SIZE) {
      if (runId !== currentRun) return;
      const batch = candidates.slice(index, index + AI_TEXT_BATCH_SIZE).filter((candidate) => candidate.node.parentNode);
      if (!batch.length) continue;
      let decisions = [];
      try {
        decisions = await promptTextBatch(session, batch);
      } catch (error) {
        if (!isDestroyedSessionError(error)) {
          await updateStatus({ lastError: `Text AI unavailable: ${formatError(error)}` });
          continue;
        }
        await resetTextSession();
        await updateStatus({ aiText: "recovering", aiReason: "The local text model session expired; recreating it." });
        session = await getTextSession();
        if (!session || runId !== currentRun) return;
        try {
          decisions = await promptTextBatch(session, batch);
        } catch (retryError) {
          await updateStatus({ lastError: `Text AI unavailable after session recovery: ${formatError(retryError)}` });
          continue;
        }
      }
      for (const decision of decisions) {
        const candidate = batch[decision.i];
        if (candidate && decision.block && candidate.node.parentNode) {
          redactTextNode(candidate.node, {
            ruleName: decision.rule || "AI match",
            reason: decision.reason || "local AI semantic match"
          });
          counters.aiText += 1;
        }
      }
    }
  }

  async function promptTextBatch(session, batch) {
    const payload = batch.map((candidate, i) => ({ i, text: candidate.text.slice(0, 600) }));
    const prompt = `User blocking rules:\n${buildRulesSummary(settings.rules)}\n\nRecent spoiler intelligence:\n${buildFullMemorySummary() || "No recent memory yet."}\n\nStrictness: ${strictnessGuidance(settings.strictness)}\n\nClassify each snippet. Return only JSON with shape {"decisions":[{"i":0,"block":false,"rule":"","reason":""}]}. Snippets:\n${JSON.stringify(payload)}`;
    const result = await session.prompt(prompt, {
      responseConstraint: {
        type: "object",
        properties: {
          decisions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                i: { type: "number" },
                block: { type: "boolean" },
                rule: { type: "string" },
                reason: { type: "string" }
              },
              required: ["i", "block"]
            }
          }
        },
        required: ["decisions"]
      }
    });
    const parsed = parseJSONResult(result);
    return Array.isArray(parsed.decisions) ? parsed.decisions : [];
  }

  async function classifyImagesWithAI(candidates, runId) {
    let session = await getImageSession();
    if (!session) return;
    for (let i = 0; i < candidates.length; i += 1) {
      if (runId !== currentRun) return;
      const candidate = candidates[i];
      if (!candidate.element.isConnected || candidate.element.closest(`.${IMAGE_SHELL_CLASS}`)) continue;
      let decision = await promptImage(session, candidate.element, candidate.metadataText);
      if (decision && decision.retryWithFreshSession) {
        await resetImageSession();
        await updateStatus({ aiVision: "recovering", aiReason: "The local vision model session expired; recreating it." });
        session = await getImageSession();
        if (!session || runId !== currentRun) return;
        decision = await promptImage(session, candidate.element, candidate.metadataText);
      }
      if (decision && decision.block) {
        redactImage(candidate.element, {
          ruleName: decision.rule || "AI vision match",
          reason: decision.reason || "local AI image match"
        });
        counters.aiImages += 1;
      }
    }
  }

  async function promptImage(session, element, metadataText) {
    const promptElement = await getPromptImageInput(element);
    if (!promptElement) {
      await updateStatus({ aiVision: "metadata fallback", aiReason: "Image could not be safely loaded for local VLM; using metadata and memory fallback." });
      return null;
    }
    try {
      const result = await session.prompt([
        {
          role: "user",
          content: [
            {
              type: "text",
              value: `User blocking rules:\n${buildRulesSummary(settings.rules)}\n\nRecent spoiler intelligence and image examples:\n${buildFullMemorySummary() || "No recent memory yet."}\n\nStrictness: ${strictnessGuidance(settings.strictness)}\n\nMetadata from title/alt/nearby text: ${metadataText || "none"}\n\nShould this image be blacked out? Return only JSON {"block":boolean,"rule":"","reason":""}.`
            },
            { type: "image", value: promptElement }
          ]
        }
      ], {
        responseConstraint: {
          type: "object",
          properties: {
            block: { type: "boolean" },
            rule: { type: "string" },
            reason: { type: "string" }
          },
          required: ["block"]
        }
      });
      return parseJSONResult(result);
    } catch (error) {
      if (isDestroyedSessionError(error)) return { retryWithFreshSession: true };
      const errorText = formatError(error);
      const isTaint = errorText.includes("SecurityError") || errorText.includes("taint");
      await updateStatus({
        aiVision: "metadata fallback",
        aiReason: isTaint
          ? "Cross-origin image was unsafe for local VLM; using metadata and memory fallback."
          : `Image AI unavailable; using metadata fallback: ${errorText}`
      });
      return null;
    }
  }

  async function getTextSession() {
    if (!settings.useLocalAI || typeof LanguageModel === "undefined") {
      await updateStatus({ aiText: "unavailable", aiReason: "LanguageModel is not exposed in this Chrome context." });
      return null;
    }
    if (!textSessionPromise) {
      textSessionPromise = createTextSession().catch((error) => {
        textSessionPromise = null;
        updateStatus({ aiText: "unavailable", lastError: formatError(error) });
        return null;
      });
    }
    return textSessionPromise;
  }

  async function createTextSession() {
    const options = {
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
      initialPrompts: [{ role: "system", content: "You are a privacy-preserving local content filter. Classify only against the user's rules. Prefer false for ambiguous content." }]
    };
    const availability = await LanguageModel.availability(options);
    await updateStatus({ aiText: availability });
    if (availability !== "available") {
      await updateStatus({
        aiText: availability,
        aiReason: availability === "downloadable" || availability === "downloading"
          ? "Open Spoilt and click Prepare local AI to download or finish preparing the text model."
          : "Text Prompt API is unavailable in this Chrome context."
      });
      return null;
    }
    return LanguageModel.create({
      ...options,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          updateStatus({ aiText: "downloading", aiDownload: event.loaded, aiReason: "Preparing the text model." });
        });
      }
    });
  }

  async function getImageSession() {
    if (!settings.useVision || typeof LanguageModel === "undefined") {
      await updateStatus({ aiVision: "unavailable" });
      return null;
    }
    if (!imageSessionPromise) {
      imageSessionPromise = createImageSession().catch((error) => {
        imageSessionPromise = null;
        updateStatus({ aiVision: "unavailable", lastError: formatError(error) });
        return null;
      });
    }
    return imageSessionPromise;
  }

  async function createImageSession() {
    const options = {
      expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
      initialPrompts: [{ role: "system", content: "You are a privacy-preserving local image content filter. Classify only against the user's rules. Prefer false for ambiguous content." }]
    };
    const availability = await LanguageModel.availability(options);
    await updateStatus({ aiVision: availability });
    if (availability !== "available") {
      await updateStatus({
        aiVision: availability === "unavailable" ? "fallback" : availability,
        aiReason: availability === "downloadable" || availability === "downloading"
          ? "Vision is not ready; using title, alt text, captions, and source metadata until Prepare local AI finishes."
          : "Vision Prompt API is unavailable; using image metadata fallback."
      });
      return null;
    }
    return LanguageModel.create({
      ...options,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          updateStatus({ aiVision: "downloading", aiDownload: event.loaded, aiReason: "Preparing the vision model." });
        });
      }
    });
  }

  function resetAI() {
    Promise.resolve(textSessionPromise).then((session) => session && session.destroy && session.destroy()).catch(() => {});
    Promise.resolve(imageSessionPromise).then((session) => session && session.destroy && session.destroy()).catch(() => {});
    textSessionPromise = null;
    imageSessionPromise = null;
  }

  async function resetTextSession() {
    const oldSessionPromise = textSessionPromise;
    textSessionPromise = null;
    await Promise.resolve(oldSessionPromise).then((session) => session && session.destroy && session.destroy()).catch(() => {});
  }

  async function resetImageSession() {
    const oldSessionPromise = imageSessionPromise;
    imageSessionPromise = null;
    await Promise.resolve(oldSessionPromise).then((session) => session && session.destroy && session.destroy()).catch(() => {});
  }

  function isDestroyedSessionError(error) {
    const text = formatError(error).toLowerCase();
    return text.includes("invalidstateerror") && (text.includes("destroyed") || text.includes("session"));
  }

  function keywordMatch(text, rules) {
    return directKeywordMatch(text, rules) || descriptionMatch(text);
  }

  function directKeywordMatch(text, rules) {
    const source = normalizeComparableText(text);
    if (!source) return null;
    for (const rule of rules || []) {
      for (const keyword of rule.keywords || []) {
        const needle = normalizeComparableText(keyword);
        if (needle && source.includes(needle)) {
          return { ruleId: rule.id, ruleName: rule.name, reason: `keyword: ${keyword}` };
        }
      }
    }
    return null;
  }

  function descriptionMatch(text) {
    const source = normalizeComparableText(text);
    if (!source) return null;
    for (const rule of settings.rules || []) {
      const match = descriptionFallbackMatch(source, rule);
      if (match) return match;
    }
    return null;
  }

  function memoryLookup(text) {
    return typeof memoryMatch === "function" ? memoryMatch(text, settings.rules, spoilerMemory) : null;
  }

  function buildFullMemorySummary() {
    if (typeof buildMemoryContext !== "function") return "";
    return (settings.rules || []).map((rule) => {
      const context = buildMemoryContext(spoilerMemory, rule.id, 5);
      return context ? `${rule.name}:\n${context}` : "";
    }).filter(Boolean).join("\n");
  }

  function descriptionFallbackMatch(source, rule) {
    const terms = getFallbackTerms(rule);
    if (!terms.length) return null;
    const matchedTerms = terms.filter((term) => source.includes(term));
    const needed = Math.min(2, terms.length);
    if (matchedTerms.length >= needed) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        reason: `description fallback: ${matchedTerms.slice(0, 3).join(", ")}`
      };
    }
    return null;
  }

  function getFallbackTerms(rule) {
    const text = normalizeComparableText(`${rule.name || ""} ${rule.description || ""}`);
    const phrases = [];
    const quoted = String(`${rule.name || ""} ${rule.description || ""}`).match(/"([^"]+)"|'([^']+)'/g) || [];
    for (const phrase of quoted) {
      const normalized = normalizeComparableText(phrase.replace(/^["']|["']$/g, ""));
      if (normalized.length >= MIN_FALLBACK_TERM_LENGTH) phrases.push(normalized);
    }
    const words = text.split(" ").filter((word) => {
      return word.length >= MIN_FALLBACK_TERM_LENGTH
        && !FALLBACK_STOP_WORDS.has(word)
        && !/^\d+$/.test(word);
    });
    const terms = [...phrases, ...words];
    return Array.from(new Set(terms)).slice(0, 30);
  }

  function getScanSignature() {
    const rulesSignature = settings.rules.map((rule) => [
      rule.id,
      rule.name,
      rule.description,
      (rule.keywords || []).join("|")
    ].join(":")).join(";");
    return [
      settings.strictness,
      settings.useLocalAI,
      settings.useVision,
      settings.scanText,
      settings.scanImages,
      settings.memoryEnabled,
      spoilerMemory.lastUpdatedAt || "",
      rulesSignature
    ].join("::");
  }

  function getImageMetadata(element) {
    const imageElement = getPromptImageElement(element);
    const parts = [
      imageElement.getAttribute("alt"),
      imageElement.getAttribute("title"),
      imageElement.getAttribute("aria-label"),
      imageElement.getAttribute("poster"),
      imageElement.currentSrc,
      imageElement.src,
      nearestCaptionText(element)
    ];
    return normalizeWhitespace(parts.filter(Boolean).join(" ")).slice(0, 1000);
  }

  function getPromptImageElement(element) {
    if (element.tagName && element.tagName.toLowerCase() === "picture") {
      return element.querySelector("img") || element;
    }
    return element;
  }

  async function getPromptImageInput(element) {
    const imageElement = getPromptImageElement(element);
    const source = imageElement.currentSrc || imageElement.src || imageElement.getAttribute("href") || "";
    if (!source) return imageElement;
    if (/^data:/i.test(source)) return dataUrlToBlob(source);
    if (/^blob:/i.test(source) || isSameOriginUrl(source)) return imageElement;
    try {
      const response = await chrome.runtime.sendMessage({ scope: "spoilt", type: "fetchImageDataUrl", url: source });
      if (!response || !response.ok || !response.result || !response.result.dataUrl) return null;
      return dataUrlToBlob(response.result.dataUrl);
    } catch (_error) {
      return null;
    }
  }

  async function dataUrlToBlob(dataUrl) {
    return fetch(dataUrl).then((response) => response.blob());
  }

  function isSameOriginUrl(url) {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch (_error) {
      return false;
    }
  }

  function nearestCaptionText(element) {
    const figure = element.closest("figure");
    if (figure) {
      const caption = figure.querySelector("figcaption");
      if (caption) return caption.textContent;
    }
    return element.parentElement ? element.parentElement.getAttribute("aria-label") || "" : "";
  }

  function buildRulesSummary(rules) {
    return (rules || []).map((rule, index) => {
      const keywords = (rule.keywords || []).slice(0, 20).join(", ") || "none";
      return `${index + 1}. ${rule.name}: ${rule.description || "No description."} Keywords: ${keywords}`;
    }).join("\n");
  }

  function strictnessGuidance(strictness) {
    if (strictness === "loose") return "Mask content when it probably relates to any rule, including indirect hints.";
    if (strictness === "strict") return "Mask only when the content clearly and specifically matches a rule.";
    return "Mask when there is a clear semantic match. Do not mask generic unrelated text.";
  }

  function parseJSONResult(value) {
    if (typeof value !== "string") return value || {};
    try {
      return JSON.parse(value);
    } catch (_error) {
      const match = value.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : {};
    }
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

  function normalizeWhitespace(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function formatError(error) {
    if (!error) return "unknown error";
    return error.name ? `${error.name}: ${error.message || ""}`.trim() : String(error);
  }

  async function updateStatus(patch) {
    const status = await getStatus();
    await chrome.storage.local.set({
      [STATUS_KEY]: {
        ...status,
        ...patch,
        updatedAt: new Date().toISOString()
      }
    });
  }

  async function getStatus() {
    const result = await chrome.storage.local.get(STATUS_KEY);
    return result[STATUS_KEY] || {};
  }

  async function loadMemory() {
    const result = await chrome.storage.local.get(MEMORY_KEY);
    return typeof normalizeMemory === "function" ? normalizeMemory(result[MEMORY_KEY]) : (result[MEMORY_KEY] || { entries: [], imageExamples: [] });
  }
})();
