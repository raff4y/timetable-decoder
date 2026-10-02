// Proves the server parser is a faithful port of the v1 browser parser. The
// original lives frozen in tests/fixtures/legacy-app.js (app.js itself no longer
// has a parser): it is loaded (unedited) in a vm context and its output is
// deep-compared with server/parser on the synthetic workbooks (always) and on
// the real department exports in the repo root (when they are present).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkbook } from '../server/parser/index.js';
import { loadOriginalParser, toArrayBuffer, VENDOR_XLSX } from './fixtures/original-parser.js';
import { flatWorkbook, gridWorkbook } from './fixtures/build-workbooks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REAL_FILES = [
  'EE Time Table (Fall 2026) v1.0.xlsx',
  'FSC_F26_TT_v1.0.7_14082026.xlsx',
  'Final_Version_FA_26_FSM_Timetable_ver 0.2.xlsx',
];

// Objects from the vm realm have a different Object.prototype; compare as JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));

/** The port adds meta.template and warnings; everything else must be identical. */
function normalizePort(out) {
  const { template, ...meta } = out.meta;
  return { template, result: plain({ meta, sections: out.sections }) };
}

const hasVendor = fs.existsSync(VENDOR_XLSX);
const originals = {
  node: loadOriginalParser('node'),
  vendor: hasVendor ? loadOriginalParser('vendor') : null,
};

function compare(buffer, fileName, expectedTemplate) {
  const port = normalizePort(parseWorkbook(buffer, fileName));
  if (expectedTemplate) assert.equal(port.template, expectedTemplate);

  for (const [label, original] of Object.entries(originals)) {
    if (!original) continue;
    const expected = plain(original(toArrayBuffer(buffer), fileName));
    assert.deepEqual(port.result, expected, `port differs from original parser (xlsx source: ${label})`);
  }
  return port.result;
}

test('synthetic flat workbook: port matches original', () => {
  const out = compare(flatWorkbook(), 'flat.xlsx', 'flat');
  assert.ok(out.sections.length >= 3);
});

test('synthetic grid workbook: port matches original', () => {
  const out = compare(gridWorkbook(), 'grid.xlsx', 'grid');
  assert.ok(out.sections.length >= 3);
});

for (const file of REAL_FILES) {
  const full = path.join(ROOT, file);
  const present = fs.existsSync(full);
  test(`real export: ${file}`, { skip: present ? false : 'file not present (not committed)' }, (t) => {
    const buffer = fs.readFileSync(full);
    const out = compare(buffer, file);
    const meetings = out.sections.reduce((n, s) => n + s.meetings.length, 0);
    assert.ok(out.sections.length > 0 && meetings > 0);
    t.diagnostic(`${out.sections.length} sections, ${meetings} meetings`);
  });
}
