#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { openPerformanceEngine } from "./helpers/performance-engine.mjs";

const root = resolve(import.meta.dirname, "..");
const extensionPath = resolve(process.env.SPOILT_EXTENSION_PATH || resolve(root, ".output/chrome-mv3"));
const artifacts = resolve(root, ".artifacts/performance");
const report = {
  model: "Clone-aware synthetic model through production content/background/analysis routing",
  nativeBenchmark: false,
  syntheticDelaysMs: { create: 40, clone: 5, prompt: 40, priorityCasePrompt: 200 },
  result: "running", checks: [],
};
await mkdir(artifacts, { recursive: true });
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/priority") {
    response.end(`<!doctype html><style>body{margin:0}.offscreen{position:absolute;top:5000px;left:0}</style>
      <main>${Array.from({ length: 55 }, (_, i) => `<p class="offscreen">Perf deferred passage ${i}</p>`).join("")}
      <p id="visible" style="position:absolute;top:8px;left:8px">Perf visible passage</p></main>`);
  } else if (request.url === "/image") {
    response.end('<!doctype html><canvas id="pixels" width="2048" height="64" style="width:1024px;height:32px"></canvas><script>const draw=document.querySelector("canvas").getContext("2d");draw.fillStyle="red";draw.fillRect(0,0,2048,64);</script>');
  } else {
    response.end(`<!doctype html><main>
      <p id="positive-a">Perf positive semantic outcome</p>
      <p id="positive-b">Perf positive semantic outcome</p>
      <p id="positive-c">Perf positive semantic outcome</p>
      <p id="safe-a">Perf harmless repeated passage</p>
      <p id="safe-b">Perf harmless repeated passage</p>
      <p id="beta">Perf beta semantic outcome</p></main>`);
  }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
let engine;
try {
  context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, chromiumSandbox: true,
    viewport: { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  report.browserVersion = context.browser()?.version();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const settings = patch => worker.evaluate(async patch => {
    const current = (await chrome.storage.sync.get("spoilt.settings"))["spoilt.settings"] || {};
    await chrome.storage.sync.set({ "spoilt.settings": { ...current, ...patch } });
  }, patch);
  const rule = (name, mode = "Alpha") => ({ id: "synthetic-boundary", name,
    description: mode === "Beta" ? "Scenario criterion BETA_MODE" : "Scenario criterion ALPHA_MODE",
    keywords: ["unmatched-fixture-marker"], enabled: true });
  await settings({ enabled: true, prefetchLinks: false, useLocalAI: true, useVision: false,
    scanText: true, scanImages: false, memoryEnabled: false, rules: [rule("AlphaBoundary")] });
  engine = await openPerformanceEngine(context, extensionId);
  const stats = () => engine.evaluate(() => structuredClone(globalThis.__performanceModel));
  const allText = value => value.textBatches.flat();
  const occurrences = (value, text) => allText(value).filter(item => item === text).length;
  const check = (name, data = {}) => report.checks.push({ name, passed: true, ...data });

  const page = await context.newPage();
  await page.bringToFront();
  const coldStart = performance.now();
  await page.goto(`${origin}/cache`);
  await until(async () => (await page.locator('[id^="positive-"] .spoilt-redacted-text').count()) === 3, "positive duplicate concealment");
  await until(async () => (await stats()).activePrompts === 0, "first prompt completion");
  let snapshot = await stats();
  assert.equal(snapshot.creates, 1, "First page should create a single pristine baseline");
  assert.equal(snapshot.clones, 1, "Duplicate snippets should fit one independent page clone");
  assert.equal(occurrences(snapshot, "Perf positive semantic outcome"), 1, "Duplicate positive snippets reached the model repeatedly");
  assert.equal(occurrences(snapshot, "Perf harmless repeated passage"), 1, "Duplicate safe snippets reached the model repeatedly");
  assert.equal(await page.locator('[id^="safe-"] .spoilt-redacted-text').count(), 0);
  assert.equal(await page.locator('#beta .spoilt-redacted-text').count(), 0);
  check("deduplicated positives fan out and safe text stays visible", {
    syntheticNavigationToMasksMs: round(performance.now() - coldStart),
    fixtureTextNodes: 6, uniqueSnippets: allText(snapshot).length, batches: snapshot.textBatches.length,
    baselineCreates: snapshot.creates, independentClones: snapshot.clones, maskedCopies: 3,
  });

  const beforeHydration = snapshot.textBatches.length;
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('[id^="positive-"]')) element.textContent = "Perf positive semantic outcome";
      for (const element of document.querySelectorAll('[id^="safe-"]')) element.textContent = "Perf harmless repeated passage";
    });
    await page.waitForTimeout(250);
    assert.equal(await page.locator('[id^="positive-"] .spoilt-redacted-text').count(), 3);
  }
  snapshot = await stats();
  assert.equal(snapshot.textBatches.length, beforeHydration, "Exact positive/negative hydration cache made another model call");
  check("three hydration rounds reuse exact positive and negative decisions", { additionalBatches: 0, hydrationRounds: 3 });

  const warmStart = performance.now();
  await page.evaluate(() => {
    const p = document.createElement("p"); p.textContent = "Perf harmless warm addition"; document.querySelector("main").append(p);
  });
  await until(async () => occurrences(await stats(), "Perf harmless warm addition") === 1, "warm independent batch");
  await until(async () => {
    const value = await stats();
    return value.activePrompts === 0 && value.cloneDestroys === value.clonePrompts;
  }, "warm classification completion");
  snapshot = await stats();
  assert.equal(snapshot.creates, 1, "Warm operation recreated its fixed-context baseline");
  assert.equal(snapshot.clones, 2, "Warm operation did not use its own disposable clone");
  assert.equal(snapshot.baselinePrompts, 0, "Page text was appended to the pristine baseline");
  assert.equal(snapshot.maxPriorPagePrompts, 0, "Page history carried into another operation");
  assert.equal(snapshot.fixedContextHadPageText, false, "Page text was seeded into a baseline");
  check("warm batches reuse context with independent disposable clones", {
    syntheticMutationToClassificationMs: round(performance.now() - warmStart), baselineCreates: snapshot.creates,
    independentClones: snapshot.clones, priorPagePrompts: snapshot.maxPriorPagePrompts,
  });
  const beforeRename = snapshot;
  await settings({ rules: [rule("Renamed organizational category")] });
  await until(async () => (await page.locator('#positive-a .spoilt-redacted-text').getAttribute("title"))?.includes("Renamed organizational category"), "updated display label");
  await page.waitForTimeout(250);
  snapshot = await stats();
  assert.equal(snapshot.textBatches.length, beforeRename.textBatches.length, "Renaming a label repeated semantic decisions");
  assert.equal(snapshot.creates, beforeRename.creates, "Renaming a label recreated a fixed-context baseline");
  assert.equal(await page.locator('[id^="positive-"] .spoilt-redacted-text').count(), 3, "Rename changed positive decisions");
  assert.equal(snapshot.fixedContextHadLabel, false, "An organizational title leaked into native classification context");
  await page.evaluate(() => { const p=document.createElement("p"); p.id="label-only"; p.textContent="Renamed organizational category"; document.querySelector("main").append(p); });
  await until(async () => occurrences(await stats(), "Renamed organizational category") === 1, "label text classified as ordinary content");
  assert.equal(await page.locator('#label-only .spoilt-redacted-text').count(), 0, "Display title became matching content");
  check("renaming changes displayed labels without changing filtering or model context", {
    renameAdditionalBatches: 0, renameAdditionalBaselines: 0, titleTextUnmasked: true, nativeContextContainsTitle: false,
  });
  await page.close();

  const priorityPage = await context.newPage();
  await priorityPage.bringToFront();
  const beforePriority = (await stats()).textBatches.length;
  const beforePriorityStarts = (await stats()).textBatchStarts.length;
  await engine.evaluate(() => { globalThis.__performancePromptDelayMs = 200; });
  await priorityPage.goto(`${origin}/priority`);
  await until(async () => (await stats()).textBatchStarts.length > beforePriorityStarts, "pending first priority batch");
  await priorityPage.evaluate(() => {
    const p = document.createElement("p"); p.id = "new-visible"; p.textContent = "Perf newly visible passage";
    p.style.cssText = "position:absolute;top:40px;left:8px";
    document.querySelector("main").prepend(p);
  });
  await until(async () => allText(await stats()).filter(text => text.startsWith("Perf deferred passage ")).length === 55, "eventual deferred text coverage");
  snapshot = await stats();
  const priorityBatches = snapshot.textBatches.slice(beforePriority);
  assert.equal(priorityBatches[0][0], "Perf visible passage", "Offscreen DOM order delayed visible text");
  assert.equal(priorityBatches[1][0], "Perf newly visible passage", "Visible prepend waited behind the existing deferred queue");
  const deferred = priorityBatches.flat().filter(text => text.startsWith("Perf deferred passage "));
  assert.equal(new Set(deferred).size, 55, "Deferred coverage omitted or duplicated a synthetic snippet");
  assert.equal(deferred.length, 55);
  check("visible text precedes offscreen DOM order and deferred text finishes", {
    offscreenSnippets: 55, classifiedOffscreenSnippets: deferred.length, batches: priorityBatches.length,
    firstSnippetInViewport: true, visiblePrependInNextBatch: true,
  });
  await engine.evaluate(() => { globalThis.__performancePromptDelayMs = 40; });
  await priorityPage.close();

  const scopePage = await context.newPage();
  await scopePage.bringToFront();
  await scopePage.goto(`${origin}/scope`);
  await until(async () => (await scopePage.locator('[id^="positive-"] .spoilt-redacted-text').count()) === 3, "initial scoped positive decisions");
  await until(async () => (await stats()).activePrompts === 0, "scoped initial completion");
  const beforeSettings = await stats();
  await settings({ rules: [rule("BetaBoundary", "Beta")] });
  await until(async () => (await scopePage.locator('#beta .spoilt-redacted-text').count()) === 1
    && (await scopePage.locator('[id^="positive-"] .spoilt-redacted-text').count()) === 0, "changed boundaries replace exact decisions");
  snapshot = await stats();
  assert.equal(snapshot.creates, beforeSettings.creates + 1, "Changed settings reused a stale baseline");
  assert.equal(snapshot.baselineDestroys, beforeSettings.baselineDestroys + 1, "Changed settings retained a stale baseline");
  const oldBetaCount = occurrences(snapshot, "Perf beta semantic outcome");
  await scopePage.evaluate(() => { history.pushState({}, "", "/scope?changed=1"); document.querySelector("#beta").textContent = "Perf beta semantic outcome"; });
  await until(async () => occurrences(await stats(), "Perf beta semantic outcome") === oldBetaCount + 1, "route-scoped semantic reclassification");
  snapshot = await stats();
  assert.equal(snapshot.creates, beforeSettings.creates + 1, "New route unnecessarily recreated unchanged fixed context");
  check("settings and routes invalidate decisions while fixed context remains scoped", {
    newBaselineAfterSettings: 1, staleBaselineDestroyed: 1, routeReclassification: true,
    newBaselineAfterRouteOnly: 0,
  });
  await scopePage.close();

  await settings({ scanText: false, scanImages: true, useVision: true });
  const imagePage = await context.newPage();
  await imagePage.bringToFront();
  await imagePage.goto(`${origin}/image`);
  await imagePage.waitForSelector(".spoilt-image-shell #pixels", { state: "attached", timeout: 10000 });
  snapshot = await stats();
  assert.equal(snapshot.imageInputs.length, 1);
  const pixels = snapshot.imageInputs[0];
  assert.equal(pixels.width, 1024); assert.equal(pixels.height, 32);
  assert(pixels.bytes > 0 && pixels.bytes <= 1_500_000);
  assert(pixels.firstPixel[0] > 240 && pixels.firstPixel[1] < 20 && pixels.firstPixel[2] < 20);
  check("image serialization and classification remain active", { imagePrompts: 1,
    serializedWidth: pixels.width, serializedHeight: pixels.height, serializedBytes: pixels.bytes });
  await imagePage.close();

  await until(async () => {
    const value = await stats();
    return value.activePrompts === 0 && value.cloneDestroys === value.clonePrompts;
  }, "final inference and disposable clone cleanup");
  snapshot = await stats();
  assert.equal(snapshot.maxPriorPagePrompts, 0);
  assert.equal(snapshot.baselinePrompts, 0);
  assert.equal(snapshot.cloneDestroys, snapshot.clonePrompts, "A disposable classification clone was retained");
  report.sessionCounts = Object.fromEntries(["creates", "clones", "baselinePrompts", "clonePrompts", "baselineDestroys", "cloneDestroys", "maxPriorPagePrompts"]
    .map(key => [key, snapshot[key]]));
  const diagnostics = await engine.locator("#performance-data").textContent();
  if (diagnostics?.trim()) report.phaseDiagnostics = JSON.parse(diagnostics);
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.failure = error.message;
  throw error;
} finally {
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify(report, null, 2));
  await context?.close();
  await new Promise(done => server.close(done));
}
console.log(JSON.stringify(report, null, 2));

function round(value) { return Math.round(value * 10) / 10; }
async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
