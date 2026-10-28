// Explicit native acceptance probe, separate from deterministic mocked CI.
// Never requests a model download or changes browser/AI flags.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const extensionPath = resolve(process.env.SPOILT_EXTENSION_PATH || resolve(root, ".output/chrome-mv3"));
const artifactDir = resolve(root, ".artifacts/native");
const report = { modelMocks: false, extraAiFlags: false, downloadsRequested: false, profile: "fresh temporary test profile", result: "blocked", checks: [] };
await mkdir(artifactDir, { recursive: true });
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end('<!doctype html><h1>The captain quietly survives the battle</h1><p>Ordinary gardening advice</p>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
let context;
try {
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, chromiumSandbox: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  report.browserVersion = context.browser()?.version();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  report.extensionId = extensionId;
  await worker.evaluate(async () => {
    await chrome.storage.sync.set({ "spoilt.settings": { enabled: true, memoryEnabled: false, prefetchLinks: false,
      useLocalAI: true, useVision: false, scanImages: false, scanText: true,
      rules: [{ id: "story", name: "Battle outcomes", description: "Hide whether the captain survives the battle.", keywords: ["nonmatchingplaceholder"], enabled: true }] } });
  });
  const engine = await context.newPage();
  await engine.goto(`chrome-extension://${extensionId}/analysis.html`);
  await engine.locator('[data-native-host="connected"]').waitFor();
  report.native = await engine.evaluate(async () => {
    const output = { languageModelType: typeof LanguageModel, secureContext: isSecureContext, inferenceAttempted: false };
    if (typeof LanguageModel === "undefined") return output;
    const options = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };
    output.availability = await LanguageModel.availability(options);
    const imageOptions = { ...options, expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }] };
    output.imageAvailability = await LanguageModel.availability(imageOptions);
    if (output.availability !== "available") return output;
    const signal = AbortSignal.timeout(20000);
    const session = await LanguageModel.create({ ...options, signal });
    try {
      output.inferenceAttempted = true;
      output.syntheticReply = await session.prompt("Reply only with the number 2. This is a synthetic local capability test.", { signal });
    } finally { session.destroy(); }
    if (output.imageAvailability === "available") {
      const imageSignal = AbortSignal.timeout(20000);
      const imageSession = await LanguageModel.create({ ...imageOptions, signal: imageSignal });
      try {
        const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
        const draw = canvas.getContext("2d"); draw.fillStyle = "red"; draw.fillRect(0, 0, 32, 32);
        const blob = await new Promise(done => canvas.toBlob(done, "image/png"));
        output.syntheticImageReply = await imageSession.prompt([{ role: "user", content: [
          { type: "text", value: "Name only the color of this synthetic square." }, { type: "image", value: blob },
        ] }], { signal: imageSignal });
      } finally { imageSession.destroy(); }
    }
    return output;
  });
  if (!report.native.inferenceAttempted) {
    report.blocker = `Native model ${report.native.availability || "API missing"} in the extension document. No download requested. Open Spoilt's analysis tab in a supported normal Chrome profile and explicitly prepare the model there.`;
    process.exitCode = 2;
  } else {
    assert.equal(report.native.syntheticReply.trim(), "2", "The native synthetic prompt did not produce the expected answer");
    report.checks.push("Real native prompt in supported extension document succeeded");
    if (report.native.syntheticImageReply) {
      assert.match(report.native.syntheticImageReply.trim(), /^red[.!]?$/i, "Native vision did not identify the synthetic square");
      report.checks.push("Real native vision prompt identified a synthetic red square");
    }
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector("h1 .spoilt-redacted-text", { timeout: 30000 });
    assert.equal(await page.locator("p .spoilt-redacted-text").count(), 0, "Native classifier concealed safe synthetic prose");
    report.checks.push("Production internal routing classified synthetic semantic match and preserved safe prose");
    report.result = "passed";
  }
} catch (error) {
  report.result = "failed";
  report.error = `${error.name}: ${error.message}`;
  process.exitCode = 1;
} finally {
  await context?.close();
  await new Promise(done => server.close(done));
  await writeFile(resolve(artifactDir, "native-ai.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
