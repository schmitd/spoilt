const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.minimum_chrome_version, '138');
assert.ok(manifest.content_scripts[0].js.includes('src/content.js'));
assert.ok(manifest.permissions.includes('storage'));
assert.ok(manifest.permissions.includes('activeTab'));
assert.ok(manifest.host_permissions.includes('<all_urls>'));

for (const relative of [
  'src/content.js',
  'src/content.css',
  'src/popup.html',
  'src/options.html',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png'
]) {
  assert.ok(fs.existsSync(path.join(root, relative)), `${relative} exists`);
}

console.log('manifest.test.cjs passed');
