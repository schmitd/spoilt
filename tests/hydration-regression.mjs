import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { openMockNativeEngine } from "./helpers/mock-native-engine.mjs";

const root = resolve(import.meta.dirname, "..");
const extensionPath = resolve(process.env.SPOILT_EXTENSION_PATH || resolve(root, ".output/chrome-mv3"));
const artifacts = resolve(root, ".artifacts/hydration");
await mkdir(artifacts, { recursive: true });
const spoiler = "The captain quietly survives the battle";
const reports = [];
const samplesByCase = {};
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "private, max-age=600");
  response.end(request.url === "/source"
    ? '<!doctype html><a id="target" href="/story">Read story</a>'
    : `<!doctype html><main><h1 data-probe>${spoiler}</h1><p id="safe">Ordinary safe content</p></main>`);
});
await new Promise(resolveReady => server.listen(0, "127.0.0.1", resolveReady));
const origin = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext("", {
  channel: "chromium", headless: true, chromiumSandbox: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const settings = async patch => worker.evaluate(async patch => {
    const current = (await chrome.storage.sync.get("spoilt.settings"))["spoilt.settings"] || {};
    await chrome.storage.sync.set({ "spoilt.settings": { ...current,
      memoryEnabled: false, scanImages: false, useVision: false, ...patch } });
  }, patch);
  await settings({ enabled: true, prefetchLinks: true, useLocalAI: true,
    rules: [{ id: "story", name: "Story", description: "", keywords: ["exampleterm"], enabled: true }] });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__frames = [];
    const sample = () => {
      for (const element of document.querySelectorAll("[data-probe]")) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let exposed = false;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.data.trim()) continue;
          const style = getComputedStyle(node.parentElement);
          let hidden = style.color === "rgba(0, 0, 0, 0)" || style.visibility === "hidden";
          for (let parent = node.parentElement; parent; parent = parent.parentElement) {
            const ancestorStyle = getComputedStyle(parent);
            hidden ||= ancestorStyle.display === "none" || ancestorStyle.opacity === "0";
          }
          exposed ||= !hidden;
        }
        window.__frames.push({ at: performance.now(), url: location.href, text: element.textContent, exposed });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  let engine;
  const closeModel = async () => { if (engine && !engine.isClosed()) await engine.close(); };
  const installModel = async (delay = 0) => {
    await closeModel();
    engine = await openMockNativeEngine(context, extensionId, { delay, spoiler });
    await page.bringToFront();
  };
  const frames = async (label, predicate, expectExposure = false) => {
    const samples = await page.evaluate(() => window.__frames);
    const selected = samples.filter(predicate);
    assert(selected.length > 0, `${label}: no sampled frames`);
    const exposed = selected.filter(frame => frame.exposed);
    samplesByCase[label] = selected;
    reports.push({ label, frames: selected.length, exposedFrames: exposed.length });
    await writeFile(resolve(artifacts, "frames.json"), JSON.stringify({ browserVersion: context.browser()?.version(), model: "extension-document mock via production internal messaging", reports, samplesByCase }, null, 2));
    assert(expectExposure ? exposed.length > 0 : exposed.length === 0,
      `${label}: ${exposed.length}/${selected.length} exposed frames`);
  };

  await page.goto(`${origin}/source`);
  await installModel(600);
  await page.waitForTimeout(500);
  await page.locator("#target").hover();
  await until(() => worker.evaluate(async () => Object.values(await chrome.storage.session.get(null))
    .some(value => value?.matches?.some(item => item.text === "The captain quietly survives the battle"))), "prefetched semantic result");
  assert((await engine.evaluate(() => globalThis.__modelCalls)) > 0);
  await closeModel();
  await page.locator("#target").click();
  await page.waitForSelector("h1 .spoilt-redacted-text");
  await page.waitForTimeout(120);
  await frames("prepared initial load", frame => frame.text === spoiler);
  await page.evaluate(text => {
    window.__frames = [];
    document.querySelector("h1").innerHTML = '<strong>The captain</strong> quietly survives <em>the battle</em>';
  }, spoiler);
  await page.waitForTimeout(300);
  await frames("prepared split-node hydration", frame => frame.text === spoiler);

  // Exact text is useful on the original route, but semantic decisions must not
  // silently carry across a different query or SPA route.
  await page.evaluate(text => {
    history.pushState({}, "", "/other?view=2");
    document.querySelector("h1").textContent = text;
    window.__frames = [];
  }, spoiler);
  await page.waitForTimeout(300);
  await frames("SPA cache scope", frame => frame.text === spoiler, true);

  // Without link prefetch, reuse decisions made on the live page immediately
  // while the serialized model is busy on other candidates.
  await settings({ prefetchLinks: false, useLocalAI: false });
  await page.goto(`${origin}/live`);
  await installModel(900);
  await settings({ useLocalAI: true });
  await page.waitForSelector("h1 .spoilt-redacted-text", { timeout: 10000 });
  await page.evaluate(() => {
    const pending = document.createElement("p");
    pending.textContent = "Waiting on unrelated semantic work";
    document.querySelector("main").append(pending);
  });
  await until(() => engine.evaluate(() => globalThis.__modelInputs.some(items => items.includes("Waiting on unrelated semantic work"))), "unrelated slow model work");
  await page.evaluate(text => {
    window.__frames = [];
    document.querySelector("h1").textContent = text;
    let count = 0;
    const replace = setInterval(() => {
      document.querySelector("h1").innerHTML = '<strong>The captain</strong> quietly survives <em>the battle</em>';
      if (++count === 8) clearInterval(replace);
    }, 25);
  }, spoiler);
  await page.waitForTimeout(250);
  await frames("live decision hydration", frame => frame.text === spoiler);

  await page.waitForTimeout(200);
  await closeModel();
  await page.reload();
  await page.waitForTimeout(300);
  await frames("live decision reload", frame => frame.text === spoiler);

  await worker.evaluate(async () => {
    const entries = await chrome.storage.session.get(null);
    for (const [key, value] of Object.entries(entries)) if (key.startsWith("spoilt.page.")) {
      await chrome.storage.session.set({ [key]: { ...value, createdAt: Date.now() - 61000 } });
    }
  });
  await page.reload();
  await page.waitForTimeout(300);
  await frames("expired decision cold miss", frame => frame.text === spoiler, true);

  // A decision produced for an old snapshot must never mask changed safe text.
  await settings({ useLocalAI: false });
  await page.waitForTimeout(150);
  await page.evaluate(() => { document.querySelector("h1").remove(); });
  await installModel(900);
  await settings({ useLocalAI: true });
  await page.waitForTimeout(1200);
  await engine.evaluate(() => { globalThis.__modelInputs = []; });
  await page.evaluate(text => {
    const heading = document.createElement("h2");
    heading.id = "stale"; heading.textContent = text;
    document.querySelector("main").append(heading);
  }, spoiler);
  await until(() => engine.evaluate(text => globalThis.__modelInputs.some(items => items.includes(text)), spoiler), "slow AI request to start before text mutation");
  await page.evaluate(() => { document.querySelector("#stale").firstChild.data = "Safe updated headline"; });
  await page.waitForTimeout(1200);
  assert.equal(await page.locator("#stale .spoilt-redacted-text").count(), 0, "stale AI masked changed text");

  // Navigation while an AI prompt is in flight invalidates its callback too.
  await engine.evaluate(() => { globalThis.__modelInputs = []; });
  const routeSpoiler = `${spoiler} after dawn`;
  await page.evaluate(text => { document.querySelector("#stale").textContent = text; }, routeSpoiler);
  await until(() => engine.evaluate(text => globalThis.__modelInputs.some(items => items.includes(text)), routeSpoiler), "slow AI request before route change");
  await page.evaluate(text => {
    history.pushState({}, "", "/new-route");
    document.querySelector("#stale").outerHTML = `<h1 data-probe>${text}</h1>`;
    window.__frames = [];
  }, routeSpoiler);
  // Close the native host without altering settings or cache identity.
  await closeModel();
  await page.waitForTimeout(1300);
  await frames("in-flight AI route invalidation", frame => frame.text === routeSpoiler, true);

  await settings({ useLocalAI: false, prefetchLinks: false });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    window.__frames = [];
    document.querySelector("main").innerHTML = '<h1 data-probe>exampleterm direct match</h1><input value="exampleterm"><div contenteditable="true"><b>exampleterm editor</b></div>';
  });
  await page.waitForTimeout(200);
  await frames("cold deterministic mutation", frame => frame.text === "exampleterm direct match");
  assert.equal(await page.locator("[contenteditable] .spoilt-redacted-text").count(), 0, "editable descendant was modified");
  await installModel(150);
  await settings({ useLocalAI: true });
  await page.evaluate(text => {
    const paragraph = document.createElement("p"); paragraph.id = "long-ai-match";
    paragraph.textContent = `${text} ${"ordinary words ".repeat(350)}`;
    document.querySelector("main").append(paragraph);
  }, spoiler);
  await until(() => engine.evaluate(prefix => globalThis.__modelInputs.some(items => items.some(text => text.startsWith(prefix))), `${spoiler} ordinary words`), "positive model request for the long snapshot");
  await page.waitForSelector("#long-ai-match .spoilt-redacted-text", { timeout: 3000 });
  assert((await page.locator("#long-ai-match .spoilt-redacted-text").textContent()).length > 4000);
  await settings({ maxTextNodesPerScan: 50 });
  await page.waitForTimeout(200);
  await page.evaluate(text => {
    const seed = document.createElement("p"); seed.id = "cursor-seed"; seed.textContent = text;
    document.querySelector("main").append(seed);
  }, spoiler);
  await page.waitForSelector("#cursor-seed .spoilt-redacted-text", { timeout: 3000 });
  await closeModel();
  await page.evaluate(text => {
    const section = document.createElement("section");
    section.innerHTML = Array.from({ length: 80 }, (_, i) => `<p id="queued-cursor-${i}">Ordinary safe prose ${i}</p>`).join("")
      + `<h2 id="detached-cursor-tail">${text}</h2>`;
    document.querySelector("main").append(section);
    queueMicrotask(() => section.querySelector("#queued-cursor-25").remove());
  }, spoiler);
  await page.waitForSelector("#detached-cursor-tail .spoilt-redacted-text", { timeout: 3000 });
  assert.equal(await page.locator("#queued-cursor-25").count(), 0);
  await page.screenshot({ path: resolve(artifacts, "hydration.png") });
  console.log(JSON.stringify(reports, null, 2));
} finally {
  await context.close();
  server.close();
}

async function until(predicate, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
