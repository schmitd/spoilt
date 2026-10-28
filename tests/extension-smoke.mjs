#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import net from "node:net";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const extensionPath = process.env.SPOILT_EXTENSION_PATH ? resolve(process.env.SPOILT_EXTENSION_PATH) : resolve(root, ".output/chrome-mv3");
const artifactDir = resolve(root, ".artifacts/release");
const fixturePort = await freePort();
const prefetchRequests = new Map();
const fixtureServer = createFixtureServer(root);
await new Promise((resolveReady) => fixtureServer.listen(fixturePort, "127.0.0.1", resolveReady));
await mkdir(artifactDir, { recursive: true });

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) {
    // Chromium may delay loading unpacked extensions until a tab is opened.
    const startup = await context.newPage();
    await startup.goto("chrome://extensions");
    await waitFor(() => context.serviceWorkers().length > 0, 30000, "Extension service worker did not start");
    [worker] = context.serviceWorkers();
    await startup.close();
  }
  const extensionId = new URL(worker.url()).host;

  console.log("verify global AI lease");
  await verifyAiLease(context, extensionId, worker);
  console.log("verify recoverable model creation failure");
  await verifyRecoverableModelFailure(await context.newPage(), fixturePort, worker, extensionId);
  console.log("verify options");
  await verifyOptions(await context.newPage(), extensionId);
  console.log("verify popup");
  await verifyPopup(await context.newPage(), extensionId);
  console.log("verify content script");
  await verifyContentScript(await context.newPage(), fixturePort, worker);

  console.log("verify link prefetch and navigation cache reuse");
  await verifyLinkPrefetch(await context.newPage(), fixturePort, worker);

  console.log("verify direct keyword preparation and dynamic updates");
  await verifyPreparedKeywords(await context.newPage(), fixturePort, worker);
  console.log("verify prepared results in a new tab with CDN images");
  await verifyPreparedKeywords(await context.newPage(), fixturePort, worker, true);
  console.log("verify prepared AI results before first visible frame");
  await verifyPreparedAnalysis(await context.newPage(), fixturePort, worker, extensionId);

  console.log(`extension-smoke.mjs passed (${extensionId})`);
  console.log(`screenshots: ${artifactDir}`);
} finally {
  await context.close();
  fixtureServer.close();
}

async function verifyPreparedKeywords(page, port, worker, newTab = false) {
  await worker.evaluate(async () => {
    await chrome.storage.sync.set({ "spoilt.settings": {
      enabled: true, prefetchLinks: true, useLocalAI: false, useVision: false,
      scanText: true, scanImages: true, memoryEnabled: false,
      rules: [{ id: "restricted", name: "Restricted topic", description: "", keywords: ["exampleterm"], enabled: true }],
    } });
  });
  await page.context().addInitScript(() => {
    if (location.pathname !== "/keyword/target") return;
    window.__keywordFrames = [];
    const check = () => {
      const h = document.querySelector("article h1");
      if (h) {
        const image = document.querySelector("picture img");
        window.__keywordFrames.push({ visible: getComputedStyle(document.documentElement).opacity !== "0", masked: !!h.querySelector(".spoilt-redacted-text"), imageSafe: !!image?.closest(".spoilt-image-shell") && getComputedStyle(image).visibility === "hidden" });
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  await page.goto(`http://127.0.0.1:${port}/keyword/source`);
  await page.waitForTimeout(500);
  const link = page.locator(newTab ? "#target-new" : "#target");
  await link.hover();
  await waitFor(async () => worker.evaluate(async () => {
    const entries = await chrome.storage.session.get(null);
    return Object.entries(entries).some(([key, value]) => key.startsWith("spoilt.prefetch.") && value?.matches?.some((item) => item.text === "exampleterm article headline" && item.ai === false));
  }), 10000, "Keyword decision was not prepared");
  const opened = newTab ? page.context().waitForEvent("page") : null;
  await link.click();
  const destination = opened ? await opened : page;
  await destination.waitForURL(`http://127.0.0.1:${port}/keyword/target`);
  await destination.waitForSelector("article h1 .spoilt-redacted-text");
  await destination.waitForSelector("picture img", { state: "attached" });
  await destination.waitForTimeout(200);
  const frames = await destination.evaluate(() => window.__keywordFrames);
  assert(frames.some((frame) => frame.visible));
  assert(frames.every((frame) => !frame.visible || (frame.masked && frame.imageSafe)), `Keyword appeared in visible frame: ${JSON.stringify(frames)}`);
  // Repeated unrelated DOM activity must not indefinitely postpone redaction.
  await destination.evaluate(() => {
    window.__noise = setInterval(() => document.querySelector("#noise").append(document.createElement("i")), 25);
    const p = document.createElement("p"); p.id = "dynamic-match"; p.textContent = "exampleterm dynamically added";
    document.querySelector("article").append(p);
  });
  await destination.waitForSelector("#dynamic-match .spoilt-redacted-text", { timeout: 1500 });
  await destination.evaluate(() => clearInterval(window.__noise));
  await destination.evaluate(() => {
    const image = document.createElement("img"); image.id = "late-image";
    image.alt = "exampleterm late image"; image.src = "/keyword/late-image.svg";
    document.querySelector("article").append(image);
  });
  await destination.waitForSelector(".spoilt-image-shell #late-image", { state: "attached", timeout: 2000 });
  if (destination !== page) await destination.close();
  await page.close();
}

async function verifyPreparedAnalysis(page, port, worker, extensionId) {
  const spoiler = "The captain quietly survives the battle";
  await worker.evaluate(async () => {
    await chrome.storage.sync.set({ "spoilt.settings": {
      enabled: true, prefetchLinks: false, useLocalAI: false, useVision: true,
      scanText: true, scanImages: true, memoryEnabled: false,
      rules: [{ id: "story", name: "Story events", description: "Story outcomes", keywords: ["unmatchedkeyword"], enabled: true }],
    } });
  });
  await page.addInitScript(() => {
    if (!location.pathname.startsWith("/prepared/target")) return;
    window.__spoiltFrames = [];
    const check = () => {
      const headline = document.querySelector("h1");
      if (headline) {
        const rootOpacity = getComputedStyle(document.documentElement).opacity;
        const span = headline.querySelector(".spoilt-redacted-text");
        const image = document.querySelector("img");
        window.__spoiltFrames.push({ visible: rootOpacity !== "0", redacted: !!span && getComputedStyle(span).color === "rgba(0, 0, 0, 0)",
          imageSafe: !image || (!!image.closest(".spoilt-image-shell") && getComputedStyle(image).visibility === "hidden") });
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  const cdp = await page.context().newCDPSession(page);
  const contexts = [];
  cdp.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.name === "Spoilt" && context.origin === `chrome-extension://${extensionId}`) contexts.push(context.id);
  });
  await cdp.send("Runtime.enable");
  await page.goto(`http://127.0.0.1:${port}/prepared/source`);
  await waitFor(() => contexts.length > 0, 5000, "Missing source content script context");
  const nativeModel = await cdp.send("Runtime.evaluate", { contextId: contexts.at(-1), expression: 'typeof LanguageModel', returnByValue: true });
  console.log(`native Prompt API in isolated test browser: ${nativeModel.result.value}`);
  const installModel = await cdp.send("Runtime.evaluate", { contextId: contexts.at(-1), expression: `
    Object.defineProperty(globalThis, "LanguageModel", { configurable: true, value: {
      availability: async () => "available",
      create: async () => ({ destroy() {}, prompt: async (input) => {
        if (Array.isArray(input)) return JSON.stringify({ block: true, rule: "Story events" });
        const text = String(input);
        const lines = JSON.parse(text.slice(text.lastIndexOf("Snippets:\\n") + 10));
        return JSON.stringify({ decisions: lines.map(item => ({ i: item.i, block: item.text.includes("captain quietly"), rule: "Story events" })) });
      } })
    } });
  ` });
  assert(!installModel.exceptionDetails, JSON.stringify(installModel.exceptionDetails));
  await worker.evaluate(async () => {
    const data = await chrome.storage.sync.get("spoilt.settings");
    await chrome.storage.sync.set({ "spoilt.settings": { ...data["spoilt.settings"], prefetchLinks: true, useLocalAI: true } });
  });
  await page.waitForTimeout(500);
  await page.locator("#target").hover();
  try { await waitFor(async () => worker.evaluate(async (text) => {
    const entries = await chrome.storage.session.get(null);
    return Object.entries(entries).some(([key, value]) => key.startsWith("spoilt.prefetch.") && value?.matches?.some((item) => item.text === text) && value?.images?.length === 1);
  }, spoiler), 15000, "AI decision for the prefetched page was not saved"); } catch (error) {
    console.log("prefetch diagnostics", await worker.evaluate(async () => ({ session: await chrome.storage.session.get(null), local: await chrome.storage.local.get("spoilt.status") })));
    throw error;
  }
  await worker.evaluate(async () => {
    const entries = await chrome.storage.session.get(null);
    for (const [key, value] of Object.entries(entries)) if (key.startsWith("spoilt.prefetch.") && value?.url?.endsWith("/prepared/target")) {
      await chrome.storage.session.set({ [key.replace("spoilt.prefetch.", "spoilt.page.")]: {
        ...value, kind: "live", signature: "outdated rule context", createdAt: Date.now(),
      } });
    }
  });
  await page.locator("#target").click();
  await page.waitForURL(`http://127.0.0.1:${port}/prepared/target`);
  await page.waitForSelector("h1 .spoilt-redacted-text");
  await page.waitForSelector(".spoilt-image-shell img", { state: "attached" });
  await page.waitForTimeout(200);
  const frames = await page.evaluate(() => window.__spoiltFrames);
  assert(frames.some((frame) => frame.visible), "The destination eventually becomes visible");
  assert(frames.every((frame) => !frame.visible || (frame.redacted && frame.imageSafe)), `Spoiler appeared in a visible frame: ${JSON.stringify(frames)}`);
  assert.equal(await page.locator("h1 .spoilt-redacted-text").textContent(), spoiler);
  // The source model was injected only into the source's isolated world. The
  // destination has no mock, so the observed masking must come from the cache.
  await cdp.detach();
  await page.close();
}

async function verifyLinkPrefetch(page, port, worker) {
  const setPrefetch = (enabled, protection = true) => worker.evaluate(async ({ enabled, protection }) => {
    const result = await chrome.storage.sync.get("spoilt.settings");
    await chrome.storage.sync.set({ "spoilt.settings": {
      ...result["spoilt.settings"], enabled: protection, prefetchLinks: enabled,
      useLocalAI: false, memoryEnabled: false,
    } });
  }, { enabled, protection });
  await setPrefetch(false);
  await page.goto(`http://127.0.0.1:${port}/prefetch/source`);
  await page.waitForTimeout(300);
  await page.locator("#article").hover();
  await page.waitForTimeout(250);
  assert.equal(prefetchRequests.get("/prefetch/article") || 0, 0, "Opt-out must not fetch");
  await setPrefetch(true);
  await page.waitForTimeout(300);
  await page.mouse.move(600, 400);
  await page.locator("#article").hover();
  await page.mouse.move(600, 400);
  await page.waitForTimeout(200);
  assert.equal(prefetchRequests.get("/prefetch/article") || 0, 0, "Brief hover must not fetch");
  const fetched = page.waitForResponse((response) => response.url().endsWith("/prefetch/article"));
  await page.locator("#article").hover();
  await (await fetched).finished();
  assert.equal(prefetchRequests.get("/prefetch/article"), 1);
  await page.mouse.move(600, 400);
  await page.locator("#article").hover();
  await page.waitForTimeout(250);
  assert.equal(prefetchRequests.get("/prefetch/article"), 1, "Repeated hover is deduplicated");
  await page.locator("#unsafe").hover();
  await page.waitForTimeout(250);
  assert.equal(prefetchRequests.get("/prefetch/logout") || 0, 0);
  // Focus on a dynamically inserted link is also an intent signal.
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.id = "dynamic"; a.href = "/prefetch/keyboard"; a.textContent = "Keyboard article";
    document.body.append(a);
  });
  const keyboardFetch = page.waitForResponse((response) => response.url().endsWith("/prefetch/keyboard"));
  await page.locator("#dynamic").focus();
  await (await keyboardFetch).finished();
  await setPrefetch(true, false);
  await page.waitForTimeout(300);
  await page.locator("#disabled").hover();
  await page.waitForTimeout(250);
  assert.equal(prefetchRequests.get("/prefetch/disabled") || 0, 0, "Disabling protection stops prefetch");
  await page.locator("#article").click();
  await page.waitForURL(`http://127.0.0.1:${port}/prefetch/article`);
  assert.equal(await page.locator("h1").textContent(), "Prefetched article");
  assert.equal(prefetchRequests.get("/prefetch/article"), 1, "Navigation must reuse cached HTML without a second server request");
  await setPrefetch(true);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) {
      const a = document.createElement("a");
      a.id = `budget-${i}`; a.href = `/prefetch/budget-${i}`; a.textContent = `Page ${i}`;
      document.body.append(a);
    }
  });
  for (let i = 0; i < 10; i++) {
    await page.locator(`#budget-${i}`).focus();
    await page.waitForTimeout(200);
  }
  const budgetRequests = [...prefetchRequests].filter(([url]) => url.startsWith("/prefetch/budget-"));
  assert.equal(budgetRequests.length, 8, "Speculation is limited to eight requests per document");
  await page.close();
}

async function verifyRecoverableModelFailure(page, fixturePort, worker, extensionId) {
  await worker.evaluate(async () => {
    const result = await chrome.storage.sync.get("spoilt.settings");
    await chrome.storage.sync.set({
      "spoilt.settings": {
        ...result["spoilt.settings"],
        enabled: false,
        useLocalAI: true,
        useVision: false,
      },
    });
  });

  const cdp = await page.context().newCDPSession(page);
  const contexts = [];
  cdp.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.name === "Spoilt" && context.origin === `chrome-extension://${extensionId}`) {
      contexts.push(context.id);
    }
  });
  await cdp.send("Runtime.enable");
  await page.goto(`http://127.0.0.1:${fixturePort}/tests/test-page.html`);
  await waitFor(() => contexts.length > 0, 5000, "Spoilt's isolated content-script world was not created.");
  await cdp.send("Runtime.evaluate", {
    contextId: contexts.at(-1),
    expression: `
      Object.defineProperty(globalThis, "LanguageModel", {
        configurable: true,
        value: {
          availability: async () => "available",
          create: async () => {
            throw new DOMException(
              "The device is unable to create a session to run the model. Please check the result of availability() first.",
              "InvalidStateError"
            );
          }
        }
      });
    `,
  });

  await worker.evaluate(async () => {
    const result = await chrome.storage.sync.get("spoilt.settings");
    await chrome.storage.sync.set({
      "spoilt.settings": { ...result["spoilt.settings"], enabled: true },
    });
  });
  await waitFor(async () => worker.evaluate(async () => {
    const status = (await chrome.storage.local.get("spoilt.status"))["spoilt.status"];
    return status?.aiText === "recovering" && status?.lastError === "";
  }), 5000, "The model creation failure was not converted into a recoverable state.");

  await worker.evaluate(async () => {
    const result = await chrome.storage.sync.get("spoilt.settings");
    await chrome.storage.sync.set({
      "spoilt.settings": { ...result["spoilt.settings"], useVision: true },
    });
  });
  await cdp.detach();
  await page.close();
}

async function verifyAiLease(context, extensionId, worker) {
  const firstPage = await context.newPage();
  const secondPage = await context.newPage();
  await Promise.all([
    firstPage.goto(`chrome-extension://${extensionId}/popup.html`),
    secondPage.goto(`chrome-extension://${extensionId}/popup.html`),
  ]);

  const first = await firstPage.evaluate(() => chrome.runtime.sendMessage({
    scope: "spoilt",
    type: "acquireAiLease",
    requestId: "browser-lease-1",
    kind: "text",
  }));
  assert.equal(first.ok, true);
  assert(first.leaseId);

  const secondPromise = secondPage.evaluate(() => chrome.runtime.sendMessage({
    scope: "spoilt",
    type: "acquireAiLease",
    requestId: "browser-lease-2",
    kind: "image",
  }));
  const grantedEarly = await Promise.race([
    secondPromise.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 250)),
  ]);
  assert.equal(grantedEarly, false, "The background granted two model leases concurrently.");

  await firstPage.evaluate((leaseId) => chrome.runtime.sendMessage({
    scope: "spoilt",
    type: "releaseAiLease",
    leaseId,
  }), first.leaseId);
  const second = await secondPromise;
  assert.equal(second.ok, true);
  assert(second.leaseId);
  await secondPage.evaluate((leaseId) => chrome.runtime.sendMessage({
    scope: "spoilt",
    type: "releaseAiLease",
    leaseId,
  }), second.leaseId);

  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      "spoilt.status": {
        lastError: "InvalidStateError: The device is unable to create a session to run the model.",
      },
    });
  });
  await firstPage.reload();
  await firstPage.locator(".popup:not(.popup--loading)").waitFor();
  assert.equal(await firstPage.getByText(/unable to create a session/i).count(), 0);
  const storedError = await worker.evaluate(async () => (
    (await chrome.storage.local.get("spoilt.status"))["spoilt.status"]?.lastError
  ));
  assert.equal(storedError, "", "Transient model creation errors remained in extension storage.");

  await firstPage.close();
  await secondPage.close();
}

async function verifyOptions(page, extensionId) {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.getByRole("heading", { name: "Choose what reaches you" }).waitFor();
  assert.equal(await page.locator(".settings-section").count(), 5);
  await page.getByRole("button", { name: "Save boundaries" }).waitFor();
  await page.getByRole("radio", { name: "Marker" }).waitFor();
  await page.getByRole("radio", { name: "Whiteout tape" }).waitFor();
  assert.equal(await hasHorizontalOverflow(page), false);
  await capture(page, resolve(artifactDir, "options.png"));

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await hasHorizontalOverflow(page), false);
  await capture(page, resolve(artifactDir, "options-mobile.png"));
  const keywordInput = page.getByRole("textbox", { name: "Immediate keywords" });
  await keywordInput.fill("smoke-keyword");
  await keywordInput.press(",");
  await page.getByText("smoke-keyword", { exact: true }).waitFor();
  await capture(page, resolve(artifactDir, "keywords-mobile.png"));
  assert.deepEqual(errors, []);
  await page.close();
}

async function verifyPopup(page, extensionId) {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 380, height: 720 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.locator(".popup:not(.popup--loading)").waitFor();
  await page.getByText(/Your boundaries are/).waitFor();
  assert.equal(await page.getByText("Reveal this page").count(), 0);
  assert.equal(await page.locator("details").evaluate((element) => element.open), false);
  assert.equal(await hasHorizontalOverflow(page), false);
  await capture(page, resolve(artifactDir, "popup.png"));
  assert.deepEqual(errors, []);
  await page.close();
}

async function verifyContentScript(page, fixturePort, worker) {
  const errors = collectErrors(page);
  await page.goto(`http://127.0.0.1:${fixturePort}/tests/test-page.html`);
  try {
    await waitForPage(page, () => document.querySelectorAll(".spoilt-redacted-text").length >= 2, 10_000);
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      body: document.body.innerText,
      masks: document.querySelectorAll(".spoilt-redacted-text").length,
      hasRuntime: typeof chrome?.runtime?.id === "string",
    }));
    throw new Error(`Content script did not conceal the fixture.\nErrors: ${errors.join(" | ")}\nDOM: ${JSON.stringify(diagnostic)}\n${error.message}`);
  }
  const result = await page.evaluate(() => ({
    textMasks: document.querySelectorAll(".spoilt-redacted-text").length,
    imageMasks: document.querySelectorAll(".spoilt-image-shell").length,
    styles: [...document.querySelectorAll(".spoilt-redacted-text")].map((element) => element.dataset.spoiltStyle),
    textColors: [...document.querySelectorAll(".spoilt-redacted-text")].map((element) => getComputedStyle(element).color),
  }));
  assert(result.textMasks >= 2, `Expected at least 2 text masks, got ${result.textMasks}`);
  assert(result.imageMasks >= 1, `Expected at least 1 image mask, got ${result.imageMasks}`);
  assert(result.styles.every((style) => style === "whiteout"), `Expected whiteout defaults, got ${result.styles.join(", ")}`);
  assert(result.textColors.every((color) => color === "rgba(0, 0, 0, 0)"), `Concealed text became visible: ${result.textColors.join(", ")}`);

  await worker.evaluate(async () => {
    const result = await chrome.storage.sync.get("spoilt.settings");
    await chrome.storage.sync.set({
      "spoilt.settings": { ...result["spoilt.settings"], redactionStyle: "marker" },
    });
  });
  await waitForPage(page, () => (
    [...document.querySelectorAll(".spoilt-redacted-text")].length >= 2
    && [...document.querySelectorAll(".spoilt-redacted-text")].every((element) => element.dataset.spoiltStyle === "marker")
  ), 5000);

  await worker.evaluate(async () => {
    const result = await chrome.storage.sync.get("spoilt.settings");
    await chrome.storage.sync.set({
      "spoilt.settings": { ...result["spoilt.settings"], enabled: false },
    });
  });
  await waitForPage(page, () => (
    document.querySelectorAll(".spoilt-redacted-text, .spoilt-image-shell").length === 0
  ), 5000);

  await worker.evaluate(async () => {
    const result = await chrome.storage.sync.get("spoilt.settings");
    await chrome.storage.sync.set({
      "spoilt.settings": { ...result["spoilt.settings"], enabled: true, redactionStyle: "whiteout" },
    });
  });
  await waitForPage(page, () => (
    [...document.querySelectorAll(".spoilt-redacted-text")].length >= 2
    && [...document.querySelectorAll(".spoilt-redacted-text")].every((element) => element.dataset.spoiltStyle === "whiteout")
  ), 5000);
  await capture(page, resolve(artifactDir, "redaction-fixture.png"));
  assert.deepEqual(errors, []);
  await page.close();
}

function collectErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function hasHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

async function capture(page, path) {
  const session = await page.context().newCDPSession(page);
  try {
    const result = await withTimeout(
      session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }),
      1000,
      "Screenshot capture timed out",
    );
    await writeFile(path, Buffer.from(result.data, "base64"));
  } catch (error) {
    console.warn(`${error.message}; continuing without ${path}`);
  } finally {
    await session.detach();
  }
}

function withTimeout(promise, timeout, message) {
  let timeoutId;
  const timer = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeout);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeoutId));
}

function createFixtureServer(basePath) {
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url || "/", "http://localhost").pathname;
      if (pathname === "/keyword/late-image.svg") {
        response.setHeader("Content-Type", "image/svg+xml");
        setTimeout(() => response.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'), 300);
        return;
      }
      if (pathname === "/keyword/topic-image.png") {
        response.setHeader("Content-Type", "image/png");
        response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0yQAAAAASUVORK5CYII=", "base64"));
        return;
      }
      if (pathname.startsWith("/keyword/")) {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "private, max-age=600");
        response.end(pathname === "/keyword/source"
          ? '<!doctype html><a id="target" href="/keyword/target">Article</a><a id="target-new" href="/keyword/target" target="_blank" rel="noopener noreferrer">Open article in a new tab</a>'
          : `<!doctype html><nav>${Array.from({length: 100}, (_, i) => `<a>Menu entry ${i}</a>`).join("")}</nav><article><h1>exampleterm article headline</h1><picture><source srcset="http://localhost:${fixturePort}/keyword/topic-image.png?width=800 800w"><img src="http://localhost:${fixturePort}/keyword/topic-image.png?width=640" alt="exampleterm photo" width="64" height="64"></picture></article><div id="noise"></div>`);
        return;
      }
      if (pathname === "/prepared/image.png") {
        response.setHeader("Content-Type", "image/png");
        response.setHeader("Cache-Control", "private, max-age=600");
        response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0yQAAAAASUVORK5CYII=", "base64"));
        return;
      }
      if (pathname.startsWith("/prepared/")) {
        if (pathname === "/prepared/target") response.setHeader("Content-Security-Policy", "style-src 'none'");
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "private, max-age=600");
        response.end(pathname === "/prepared/source"
          ? '<!doctype html><a id="target" href="/prepared/target">Read the story</a>'
          : '<!doctype html><h1>The captain quietly survives the battle</h1><img src="/prepared/image.png" alt="A scene" width="64" height="64">');
        return;
      }
      if (pathname.startsWith("/prefetch/")) {
        prefetchRequests.set(pathname, (prefetchRequests.get(pathname) || 0) + 1);
        response.setHeader("Content-Type", "text/html");
        response.setHeader("Cache-Control", "private, max-age=600");
        response.end(pathname === "/prefetch/source"
          ? '<!doctype html><a id="article" href="/prefetch/article">Article</a><br><a id="unsafe" href="/prefetch/logout">Logout</a><br><a id="disabled" href="/prefetch/disabled">Disabled article</a>'
          : '<!doctype html><h1>Prefetched article</h1>');
        return;
      }
      if (pathname === "/favicon.ico") {
        response.statusCode = 204;
        response.end();
        return;
      }
      const filePath = resolve(basePath, `.${pathname}`);
      if (!filePath.startsWith(basePath)) throw new Error("Invalid path");
      response.setHeader("Content-Type", contentType(filePath));
      response.end(await readFile(filePath));
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
}

async function waitForPage(page, predicate, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for page condition.");
}

async function waitFor(predicate, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(message);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  return port;
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".png": return "image/png";
    default: return "application/octet-stream";
  }
}
