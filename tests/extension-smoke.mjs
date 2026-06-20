#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import net from "node:net";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const extensionPath = resolve(root, ".output/chrome-mv3");
const artifactDir = resolve(root, ".artifacts/release");
const fixturePort = await freePort();
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
  if (!worker) worker = await context.waitForEvent("serviceworker");
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

  console.log(`extension-smoke.mjs passed (${extensionId})`);
  console.log(`screenshots: ${artifactDir}`);
} finally {
  await context.close();
  fixtureServer.close();
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
