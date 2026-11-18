// Record only public package/source identity, never local profile or test state.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, ".output");
const metadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(output, "chrome-mv3/manifest.json"), "utf8"));
assert.equal(manifest.version, metadata.version, "Package and manifest versions differ");
const archives = (await readdir(output)).filter(name => name.endsWith("-chrome.zip"));
assert.equal(archives.length, 1, "Expected exactly one release ZIP after the gate");
assert.equal(archives[0], `${metadata.name}-${metadata.version}-chrome.zip`);
const hash = buffer => createHash("sha256").update(buffer).digest("hex");
const entry = async path => {
  const data = await readFile(path);
  return { path: relative(root, path).split(sep).join("/"), bytes: data.length, sha256: hash(data) };
};
const walk = async directory => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) files.push(...await walk(path));
    else if (item.isFile()) files.push(await entry(path));
    else throw new Error("Unexpected non-file build entry");
  }
  return files;
};
const assets = [
  ["01-keyword-protection-1280x800.png", 1280, 800],
  ["02-boundary-settings-1280x800.png", 1280, 800],
  ["extension-icon-128.png", 128, 128],
  ["small-promo-440x280.png", 440, 280],
];
const storeAssets = [];
for (const [name, width, height] of assets) {
  const path = resolve(root, "docs/store-assets", name);
  const bytes = await readFile(path);
  assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "Expected a PNG asset");
  assert.equal(bytes.readUInt32BE(16), width, "Unexpected asset width");
  assert.equal(bytes.readUInt32BE(20), height, "Unexpected asset height");
  storeAssets.push({ ...await entry(path), width, height });
}
const identity = {
  sourceCommit: process.env.GITHUB_SHA || null,
  sourceHead: process.env.SPOILT_SOURCE_HEAD || process.env.GITHUB_SHA || null,
  workflowRunId: process.env.GITHUB_RUN_ID || null,
  version: manifest.version,
  package: await entry(resolve(output, archives[0])),
  buildFiles: await walk(resolve(output, "chrome-mv3")),
  storeAssets,
  nativeAcceptanceComplete: false,
  note: "Created after the deterministic release gate. This artifact is a candidate, not a Store submission or proof of native inference.",
};
await writeFile(resolve(output, "store-package-identity.json"), JSON.stringify(identity, null, 2) + "\n");
console.log(JSON.stringify({ version: identity.version, packageSha256: identity.package.sha256,
  buildFiles: identity.buildFiles.length, storeAssets: storeAssets.length, nativeAcceptanceComplete: false }));
