// Local API server: maps /api/... onto the Vercel-style handler files in api/
// using plain node:http. Vite proxies /api to this in dev (see vite.config.js).
//
//   npm run dev:api        (PORT via API_PORT, default 8787; loads .env.local)
//
// Routing mirrors Vercel: api/a/b.js, api/a/b/index.js, and dynamic segments
// like api/a/[id].js (value is put on req.query.id). Files starting with "_"
// are helpers, not routes.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv, ROOT } from './load-env.mjs';

const API_DIR = path.join(ROOT, 'api');

function isRouteName(name) {
  return !name.startsWith('_');
}

/** Resolve URL segments to { file, params } or null. */
export function resolveRoute(segments, dir = API_DIR) {
  if (!segments.length) {
    const index = path.join(dir, 'index.js');
    return fs.existsSync(index) ? { file: index, params: {} } : null;
  }
  const [head, ...rest] = segments;
  if (!isRouteName(head) || head.includes('..') || head.includes('/') || head.includes('\\')) return null;

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  // Static matches win over dynamic ones.
  if (!rest.length) {
    const file = path.join(dir, `${head}.js`);
    if (fs.existsSync(file)) return { file, params: {} };
  }
  if (rest.length || fs.existsSync(path.join(dir, head))) {
    const sub = path.join(dir, head);
    if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) {
      const hit = resolveRoute(rest, sub);
      if (hit) return hit;
    }
  }

  for (const e of entries) {
    const m = /^\[(\w+)\](\.js)?$/.exec(e.name);
    if (!m || !isRouteName(e.name)) continue;
    if (!rest.length && e.isFile() && m[2]) {
      return { file: path.join(dir, e.name), params: { [m[1]]: decodeURIComponent(head) } };
    }
    if (rest.length && e.isDirectory() && !m[2]) {
      const hit = resolveRoute(rest, path.join(dir, e.name));
      if (hit) return { file: hit.file, params: { [m[1]]: decodeURIComponent(head), ...hit.params } };
    }
  }
  return null;
}

/** node:http request listener. Exported so tests can mount it on a test port. */
export async function handleApiRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  const segments = url.pathname
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean);
  let hit = null;
  try {
    hit = resolveRoute(segments);
  } catch {
    // Malformed %-escapes in a dynamic segment: not a route.
  }
  if (!hit) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  req.query = { ...Object.fromEntries(url.searchParams), ...hit.params };
  try {
    const mod = await import(pathToFileURL(hit.file).href);
    await mod.default(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

export function createApiServer() {
  return http.createServer(handleApiRequest);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv();
  const port = Number(process.env.API_PORT || 8787);
  createApiServer().listen(port, () => {
    console.log(`API dev server on http://localhost:${port}  (proxied from Vite at /api)`);
    if (!process.env.DATABASE_URL) console.warn('Warning: DATABASE_URL is not set (see .env.example).');
    if (!process.env.NEON_AUTH_URL) console.warn('Warning: NEON_AUTH_URL is not set; every sign-in will fail.');
  });
}
