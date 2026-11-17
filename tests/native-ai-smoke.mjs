// Explicit native probe, separate from mocked CI and the user's normal profile.
// No explicit model download or AI/security flags are requested. Chrome controls
// automatic model management; even availability checks may cause background work.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const extensionPath = resolve(process.env.SPOILT_EXTENSION_PATH || resolve(root, ".output/chrome-mv3"));
const artifactDir = resolve(root, ".artifacts/native");
const preflightOnly = process.argv.includes("--preflight-only");
const textRule = { id: "native-text", name: "Synthetic text boundary", keywords: [], enabled: true,
  description: "Conceal disclosures of competitive outcomes, especially the identity of a winning sports team." };
const imageRule = { id: "native-image", name: "Synthetic image boundary", keywords: [], enabled: true,
  description: "Hide images that are mostly red. Preserve images that are mostly green." };
const textFixtures = [
  { phase: "cold", positive: "The home side lifted the trophy after the final whistle.", safe: "A gardener planted basil beside the kitchen window." },
  { phase: "warm", positive: "The visitors hoisted the cup as their rivals left empty-handed.", safe: "A baker left dough to rise on the counter." },
];
const imageMetadata = ["Synthetic geometric patch A", "Synthetic geometric patch B"];
const report = {
  modelMocks: false, extraAiFlags: false, explicitDownloadsRequested: false,
  profile: "fresh temporary headless test profile",
  limitation: "Eligibility here does not establish availability in Profile 8. Use the exact normal profile for device acceptance. Chrome may independently manage/download models during availability checks.",
  timingDefinition: "Cold/warm denote first/repeat production requests for one fixed context, after direct capability probes; they are not forced GPU cold starts. Phase times are cumulative milliseconds.",
  preflightOnly, nativeAcceptanceComplete: false,
  result: "blocked", checks: [], capabilities: {},
  production: { text: { result: "not-run", runs: [] }, image: { result: "not-run", runs: [] } },
};
let context;
let server;

try {
  // Bundle the actual matcher, rather than duplicating its lexical heuristics in
  // the harness. This guard must finish before any browser/model operation.
  const bundle = await build({ entryPoints: [resolve(root, "src/core/matching.ts")], bundle: true,
    write: false, platform: "node", format: "esm", logLevel: "silent" });
  const { keywordMatch, descriptionMatch } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const assertSemanticOnly = (value, rule) => {
    assert.equal(keywordMatch(value, [rule]), null, "Native fixture has a keyword fallback match");
    assert.equal(descriptionMatch(value, [rule]), null, "Native fixture has a description fallback match");
  };
  for (const fixture of textFixtures) for (const value of [fixture.positive, fixture.safe]) assertSemanticOnly(value, textRule);
  for (const metadata of imageMetadata) assertSemanticOnly(metadata, imageRule);
  // Prove the guard rejects a fixture that a direct matcher can conceal.
  assert.throws(() => assertSemanticOnly(textFixtures[0].positive,
    { ...textRule, keywords: [textFixtures[0].positive] }), /keyword fallback/);
  report.preflight = { passed: true, textFixtures: 4, imageMetadataFixtures: 2, directFallbackMatches: 0, rejectionControlPassed: true };
  if (preflightOnly) {
    report.result = "preflight-passed";
    report.checks.push("Actual matcher rejects direct-fallback fixtures; no browser or native inference attempted");
  } else {
    server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8"); response.setHeader("Cache-Control", "no-store");
      const route = /^\/(text|image)\/(0|1)$/.exec(request.url || "");
      if (!route) { response.writeHead(404); response.end(); return; }
      if (route[1] === "text") {
        const fixture = textFixtures[Number(route[2])];
        response.end(`<!doctype html><h1 id="positive">${fixture.positive}</h1><p id="safe">${fixture.safe}</p>`);
      } else {
        response.end(`<!doctype html><canvas id="positive" width="64" height="64" aria-label="${imageMetadata[0]}"></canvas><canvas id="safe" width="64" height="64" aria-label="${imageMetadata[1]}"></canvas>
          <script>for(const [id,color] of [["positive","red"],["safe","green"]]){const draw=document.getElementById(id).getContext("2d");draw.fillStyle=color;draw.fillRect(0,0,64,64);}</script>`);
      }
    });
    await new Promise(done => server.listen(0, "127.0.0.1", done));
    context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, chromiumSandbox: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    report.browserVersion = context.browser()?.version();
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const extensionId = new URL(worker.url()).host;
    report.extensionId = extensionId;
    const configure = async kind => worker.evaluate(async ({ kind, rule }) => {
      await chrome.storage.sync.set({ "spoilt.settings": { enabled: true, memoryEnabled: false, prefetchLinks: false,
        useLocalAI: true, useVision: kind === "image", scanImages: kind === "image", scanText: kind === "text", rules: [rule] } });
    }, { kind, rule: kind === "text" ? textRule : imageRule });
    await configure("text");
    const opened = context.waitForEvent("page", { timeout: 15_000 });
    const ownedWindow = await worker.evaluate(() => chrome.windows.create({
      url: chrome.runtime.getURL("analysis.html"), type: "popup", width: 480, height: 680, focused: false,
    }));
    const engine = await opened;
    report.analysisWindow = { id: ownedWindow.id, type: ownedWindow.type };
    await engine.waitForURL(`chrome-extension://${extensionId}/analysis.html`);
    await engine.locator('[data-native-host="connected"]').waitFor({ timeout: 15_000 });

    // These direct API probes establish capability only. They cannot satisfy the
    // separate production-routing assertions below and never expose raw replies.
    const probe = async kind => engine.evaluate(async kind => {
      const output = { result: "blocked", secureContext: isSecureContext, createMs: 0, prompts: [] };
      if (typeof LanguageModel === "undefined") { output.availability = "API missing"; return output; }
      const options = { expectedInputs: [{ type: "text", languages: ["en"] }, ...(kind === "image" ? [{ type: "image" }] : [])],
        expectedOutputs: [{ type: "text", languages: ["en"] }] };
      const start = performance.now(); let timer;
      try {
        output.availability = await Promise.race([LanguageModel.availability(options),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Availability timed out")), 5_000); })]);
      } finally { clearTimeout(timer); }
      output.availabilityMs = performance.now() - start;
      if (output.availability !== "available") return output;
      const signal = AbortSignal.timeout(20_000);
      const abortable = pending => new Promise((resolve, reject) => {
        const cleanup = () => signal.removeEventListener("abort", abort);
        const abort = () => { cleanup(); reject(new DOMException("Native probe timed out", "AbortError")); };
        signal.addEventListener("abort", abort, { once: true });
        pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        if (signal.aborted) abort();
      });
      const createStart = performance.now();
      const creating = LanguageModel.create({ ...options, signal });
      void creating.then(session => { if (signal.aborted) session.destroy(); }, () => undefined);
      const session = await abortable(creating);
      output.createMs = performance.now() - createStart;
      try {
        let blob;
        if (kind === "image") {
          const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
          const draw = canvas.getContext("2d"); draw.fillStyle = "red"; draw.fillRect(0, 0, 32, 32);
          blob = await abortable(new Promise(done => canvas.toBlob(done, "image/png")));
          if (!blob) throw new Error("Synthetic image could not be encoded");
        }
        for (let index = 0; index < 2; index++) {
          const expected = String(index + 2);
          const input = kind === "text" ? `Reply only with the number ${expected}. This is a synthetic local capability test.`
            : [{ role: "user", content: [{ type: "text", value: "Name only the color of this synthetic square." }, { type: "image", value: blob }] }];
          const promptStart = performance.now(); const reply = await abortable(session.prompt(input, { signal }));
          const passed = kind === "text" ? reply.trim() === expected : /^red[.!]?$/i.test(reply.trim());
          output.prompts.push({ durationMs: performance.now() - promptStart, outputCharacters: reply.length, passed });
          if (!passed) { output.result = "failed"; return output; }
        }
        output.result = "passed"; return output;
      } finally { session.destroy(); }
    }, kind);
    const samples = async () => engine.evaluate(() => {
      const text = document.querySelector("#performance-data")?.textContent || "";
      return text.startsWith("{") ? JSON.parse(text).samples : [];
    });
    const runProduction = async (kind, index) => {
      const before = await samples(); const page = await context.newPage(); const start = performance.now();
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}/${kind}/${index}`, { timeout: 15_000 });
        const positive = kind === "text" ? "#positive .spoilt-redacted-text" : ".spoilt-image-shell #positive";
        const safe = kind === "text" ? "#safe .spoilt-redacted-text" : ".spoilt-image-shell #safe";
        await Promise.all([page.waitForSelector(positive, { timeout: 45_000 }),
          engine.waitForFunction(({ kind, offset, required }) => {
            const text = document.querySelector("#performance-data")?.textContent || "";
            if (!text.startsWith("{")) return false;
            const recent = JSON.parse(text).samples.slice(offset).filter(sample => sample.kind === kind);
            return recent.filter(sample => sample.phase === "inference" && sample.outcome === "ok").length >= required
              && recent.filter(sample => sample.phase === "total" && sample.outcome === "ok").length >= required;
          }, { kind, offset: before.length, required: kind === "image" ? 2 : 1 }, { timeout: 45_000 })]);
        assert.equal(await page.locator(safe).count(), 0, "Native production classification concealed a safe synthetic control");
        const recent = (await samples()).slice(before.length).filter(sample => sample.kind === kind);
        const inference = recent.filter(sample => sample.phase === "inference" && sample.outcome === "ok");
        const classifiedItems = inference.reduce((sum, sample) => sum + (sample.items || 0), 0);
        assert(classifiedItems >= 2, "Production diagnostics did not prove inference for positive and safe inputs");
        assert(inference.every(sample => sample.outputCharacters > 0), "Production inference supplied no model output");
        const phaseMs = Object.fromEntries(["scheduling", "queue", "settings", "availability", "memory", "session", "clone", "inference", "total"]
          .map(phase => [phase, round(recent.filter(sample => sample.phase === phase).reduce((sum, sample) => sum + sample.durationMs, 0))]));
        return { phase: index === 0 ? "cold" : "warm", navigationToVerifiedMasksMs: round(performance.now() - start), phaseMs,
          inferenceCalls: inference.length, classifiedItems, outputCharacters: inference.reduce((sum, sample) => sum + sample.outputCharacters, 0),
          sessionCreates: recent.filter(sample => sample.phase === "session").length, clones: recent.filter(sample => sample.phase === "clone").length,
          positiveMasks: await page.locator(positive).count(), safeMasks: 0 };
      } finally { await page.close(); }
    };

    report.capabilities.text = await probe("text");
    if (report.capabilities.text.result === "blocked") {
      report.blocker = `Text model ${report.capabilities.text.availability} in this fresh temporary headless profile. No explicit download requested. Normal Profile 8 remains untested by this harness.`;
      process.exitCode = 2;
    } else {
      assert.equal(report.capabilities.text.result, "passed", "Native text capability probe failed");
      report.checks.push("Direct native text capability probe passed; production routing is checked separately");
      report.production.text.result = "running";
      for (let index = 0; index < 2; index++) report.production.text.runs.push(await runProduction("text", index));
      report.production.text.result = "passed";
      report.checks.push("Production native text inference classified semantic-only positives and preserved safe controls");
      report.capabilities.image = await probe("image");
      if (report.capabilities.image.result === "blocked") {
        report.production.image.result = "blocked"; report.result = "partial"; process.exitCode = 2;
        report.blocker = "Text production inference passed, but native vision remains unavailable and unverified in this temporary profile.";
      } else {
        assert.equal(report.capabilities.image.result, "passed", "Native vision capability probe failed");
        report.production.image.result = "running";
        await configure("image");
        for (let index = 0; index < 2; index++) report.production.image.runs.push(await runProduction("image", index));
        report.production.image.result = "passed"; report.result = "passed"; report.nativeAcceptanceComplete = true;
        report.checks.push("Production native vision inference concealed red pixels and preserved green controls");
      }
    }
  }
} catch (error) {
  for (const kind of ["text", "image"]) if (report.production[kind].result === "running") report.production[kind].result = "failed";
  report.result = "failed"; report.error = `${error.name}: ${error.message}`; process.exitCode = 1;
} finally {
  await context?.close();
  if (server?.listening) await new Promise(done => server.close(done));
  await mkdir(artifactDir, { recursive: true });
  await writeFile(resolve(artifactDir, preflightOnly ? "native-preflight.json" : "native-ai.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

function round(value) { return Math.round(value * 10) / 10; }
