// Tiny .env loader (no dotenv dependency). Reads `.env.local` then `.env` from
// the repo root; real environment variables always win.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\n/g, '\n');
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[m[1]] = value;
  }
  return out;
}

export function loadEnv(dir = ROOT) {
  for (const name of ['.env.local', '.env']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}
