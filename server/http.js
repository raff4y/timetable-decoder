// Small helpers for Vercel-style (req, res) handlers. They work both on Vercel's
// Node runtime and under scripts/dev-server.mjs (plain node:http), so handlers
// must use these instead of Vercel-only conveniences like res.status().json().

import { anonymousRequestAllowed } from './rate-limit.js';

export class HttpError extends Error {
  /** `headers` are added to the error response (e.g. Retry-After on a 429). */
  constructor(status, message, details, headers) {
    super(message);
    this.status = status;
    this.details = details;
    this.headers = headers;
  }
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

export function sendError(res, err) {
  if (err instanceof HttpError) {
    for (const [name, value] of Object.entries(err.headers || {})) res.setHeader(name, String(value));
    return sendJson(res, err.status, { error: err.message, details: err.details });
  }
  console.error(err);
  return sendJson(res, 500, { error: 'Internal server error' });
}

// Vercel's Node runtime may already have consumed the stream into req.body
// (Buffer for binary types, string for text, parsed object for JSON); the dev
// server leaves req.body undefined and the stream untouched.
function preReadBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  let body;
  try {
    body = req.body;
  } catch {
    throw new HttpError(400, 'Invalid request body');
  }
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return body;
}

/** Raw request body as a Buffer, refusing anything over `limit` bytes. */
export async function readBody(req, limit = 4 * 1024 * 1024) {
  const pre = preReadBody(req);
  if (pre !== undefined) {
    const buf = Buffer.isBuffer(pre) ? pre : Buffer.from(JSON.stringify(pre), 'utf8');
    if (buf.length > limit) throw new HttpError(413, 'Request body too large');
    return buf;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Parsed JSON request body. Always a plain object: `null`, arrays, strings and
 * numbers are refused with 400, so handlers can read `body.x` without guarding.
 */
export async function readJson(req, limit = 256 * 1024) {
  const pre = preReadBody(req);
  let body;
  if (pre !== undefined && !Buffer.isBuffer(pre)) {
    body = pre;
  } else {
    const buf = await readBody(req, limit);
    if (!buf.length) return {};
    try {
      body = JSON.parse(buf.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON body');
    }
  }
  if (!isPlainObject(body)) throw new HttpError(400, 'Expected a JSON object');
  return body;
}

/**
 * Wrap a handler: dispatch by method, turn thrown HttpErrors into JSON errors.
 *   export default route({ GET: async (req, res) => ..., POST: ... })
 */
export function route(methods) {
  return async function handler(req, res) {
    const fn = methods[req.method];
    if (!fn) {
      res.setHeader('Allow', Object.keys(methods).join(', '));
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    try {
      // Requests carrying no credentials at all are throttled per IP before any
      // work is done (authenticated ones are limited per account in auth.js).
      anonymousRequestAllowed(req);
      await fn(req, res);
    } catch (err) {
      sendError(res, err);
    }
  };
}

/** Path/query param, from Vercel's req.query or the dev server's parsed URL. */
export function param(req, name) {
  if (req.query && req.query[name] !== undefined) return req.query[name];
  return new URL(req.url, 'http://local').searchParams.get(name) ?? undefined;
}
