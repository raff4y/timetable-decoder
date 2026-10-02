// Cheap wiring check without a browser: every element id a page script looks up
// must exist in its HTML, and the pages must load their scripts as ES modules.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function htmlIds(html) {
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}

function lookedUpIds(js) {
  return [...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
}

for (const [page, script] of [['app.html', 'app.js']]) {
  test(`${page}: every id used by ${script} exists`, () => {
    const ids = htmlIds(read(page));
    const used = lookedUpIds(read(script));
    assert.ok(used.length > 15, 'expected the script to look up many elements');
    assert.deepEqual(used.filter((id) => !ids.has(id)), []);
  });
}

test('app.html is a module page with no classic scripts or SheetJS', () => {
  const html = read('app.html');
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.equal(/<script(?![^>]*type="module")[^>]*src=/.test(html), false);
  assert.equal(/xlsx/i.test(html), false);
  assert.equal(/xlsx/i.test(read('app.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'vendor')), false);
});

test('admin.html only redirects to the CMS', () => {
  const html = read('admin.html');
  assert.match(html, /url=\/cms\.html/);
  assert.equal(/src=/.test(html), false);
});

test('page bodies are hidden until the auth gate resolves', () => {
  assert.match(read('app.html'), /<div class="page[^"]*" id="page" hidden>/);
  assert.match(read('app.js'), /requireUser\(\)/);
});

test('no innerHTML in the page scripts (all data is rendered as text)', () => {
  for (const f of ['app.js', 'src/app/canvas.js']) {
    assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(read(f)), false, f);
  }
});
