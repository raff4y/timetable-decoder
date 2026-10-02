// Loads the ORIGINAL browser parser out of tests/fixtures/legacy-app.js (the v1
// app.js, frozen from git commit 7653221; the live app.js no longer contains a
// parser) so tests can prove the server port behaves identically.
//
// legacy-app.js is one big IIFE that touches the DOM at the top. We take the source up
// to the point where the parser section ends (the `GENERIC_EXAMPLES` constant,
// right after parseWorkbook), append a hook that publishes parseWorkbook, close
// the IIFE, and evaluate it in a vm context with a minimal DOM stub.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const VENDOR_XLSX = path.join(HERE, 'xlsx-vendor-0.18.5.min.js');

// A permissive stand-in for any DOM element / document / window object.
function domStub() {
  const handler = {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'textContent' || prop === 'value') return target[prop] ?? '';
      if (prop in target) return target[prop];
      return new Proxy(function () {}, handler);
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
    apply() {
      return new Proxy(function () {}, handler);
    },
  };
  return new Proxy({}, handler);
}

/**
 * @param {'node'|'vendor'} xlsxSource  'node' = the xlsx npm package the server
 *   uses; 'vendor' = the SheetJS build the browser actually shipped
 *   (kept as tests/fixtures/xlsx-vendor-0.18.5.min.js, 0.18.5).
 * @returns {(buffer: Buffer, fileName: string) => object} the original parseWorkbook
 */
export function loadOriginalParser(xlsxSource = 'node') {
  const src = fs.readFileSync(path.join(HERE, 'legacy-app.js'), 'utf8');
  const marker = '  var GENERIC_EXAMPLES';
  const cut = src.indexOf(marker);
  if (cut === -1) throw new Error('legacy-app.js layout changed: could not find the end of the parser section');
  const body = src.slice(0, cut) + '\n  globalThis.__originalParseWorkbook = parseWorkbook;\n})();\n';

  const sandbox = {
    document: domStub(),
    window: { localStorage: { getItem: () => null, setItem() {} } },
    console,
    // Typed arrays created inside the context would be foreign to SheetJS.
    Uint8Array,
    ArrayBuffer,
  };

  if (xlsxSource === 'vendor') {
    const vendorPath = VENDOR_XLSX;
    // The vendored UMD build attaches XLSX to `this`/self when not under CommonJS.
    const ctx = vm.createContext(sandbox);
    ctx.self = ctx;
    ctx.globalThis = ctx;
    ctx.Buffer = Buffer;
    vm.runInContext(fs.readFileSync(vendorPath, 'utf8'), ctx, { filename: vendorPath });
    if (!ctx.XLSX) throw new Error('xlsx-vendor-0.18.5.min.js did not define XLSX');
    vm.runInContext(body, ctx, { filename: 'legacy-app.js (original parser)' });
    return ctx.__originalParseWorkbook;
  }

  sandbox.XLSX = require('xlsx');
  const ctx = vm.createContext(sandbox);
  ctx.globalThis = ctx;
  vm.runInContext(body, ctx, { filename: 'legacy-app.js (original parser)' });
  return ctx.__originalParseWorkbook;
}

/** The original takes an ArrayBuffer. */
export function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
