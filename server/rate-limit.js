// API rate limiting. Fixed windows, two layers:
//
// 1. In memory, per serverless instance: cheap, never fails, and sheds a flood
//    before it costs a database write. It is also the fallback when the
//    database is unreachable, so a DB outage never means "no limits at all".
// 2. In auth_rate_limits (001 + 006): shared by every instance, so spreading
//    requests across instances does not get around a limit.
//
// A request is refused when either layer is over. Keys are hashed, so raw
// emails / IPs / user ids never reach the table.
//
// Where each limit is applied:
//   anonymousPerIp    server/http.js route(): requests with no credentials at all
//   authFailuresPerIp server/auth.js, server/rooms/auth.js: bad/expired tokens or cookies
//   userRequests      server/auth.js: every authenticated call, per account
//   userWrites        server/auth.js: POST/PUT/PATCH/DELETE, per account
//   uploads           api/timetables/_lib.js: timetable uploads, per admin
//   roomRequests      server/rooms/auth.js: every Room Finder call, per account
// Login / password-reset endpoints keep their own, tighter limits.
//
// Authenticated traffic is limited per ACCOUNT, not per IP, on purpose: a whole
// campus can sit behind one NAT address, and must not share one budget.

import { createHash } from 'node:crypto';
import { query } from './db.js';
import { HttpError } from './http.js';

export const LIMITS = {
  // Not signed in (landing/login page checks, probes). Memory only: these are
  // answered without touching the database anyway.
  anonymousPerIp: { limit: 300, windowSeconds: 60 },
  // Invalid, forged or expired credentials. A real user produces one now and
  // then (an expired token is refreshed and retried); a guesser produces many.
  authFailuresPerIp: { limit: 60, windowSeconds: 5 * 60 },
  // ~1 request/second sustained per account. Normal use is 5-30 a minute.
  userRequests: { limit: 300, windowSeconds: 5 * 60 },
  // Autosave is debounced (800 ms), so even fast clicking stays well below this.
  userWrites: { limit: 120, windowSeconds: 5 * 60 },
  uploads: { limit: 20, windowSeconds: 10 * 60 },
  roomRequests: { limit: 300, windowSeconds: 5 * 60 },
};

/** Short stable hash for rate-limit keys, so raw emails / IPs never hit the table. */
export const hashKey = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 32);

// ------------------------------------------------------------------ client IP

// Forwarding headers are only believed behind a proxy that overwrites them.
// Vercel does (it replaces any client-sent X-Forwarded-For); anywhere else they
// are attacker-controlled, so a client could pick a fresh "IP" per request.
function trustProxyHeaders() {
  return process.env.VERCEL === '1' || process.env.TRUST_PROXY === '1';
}

function expandIpv6(ip) {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''));
}

/**
 * Canonical form used as a rate-limit identity. IPv6 is cut to its /64: one
 * subscriber usually gets a whole /64, so per-address limits would be trivial
 * to dodge by rotating addresses.
 */
export function normaliseIp(raw) {
  let ip = String(raw || '').trim().replace(/^\[|\]$/g, '');
  ip = ip.replace(/%.*$/, ''); // zone id
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return ip;
  if (ip.includes(':')) {
    const groups = expandIpv6(ip);
    if (groups) return `${groups.slice(0, 4).join(':')}::/64`;
  }
  return ip.slice(0, 64) || 'unknown';
}

export function clientIp(req) {
  const headers = req.headers || {};
  if (trustProxyHeaders()) {
    for (const name of ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for']) {
      const v = headers[name];
      if (typeof v === 'string' && v.trim()) return normaliseIp(v.split(',')[0]);
    }
  }
  return normaliseIp(req.socket?.remoteAddress || 'unknown');
}

// ------------------------------------------------------------------ in memory

const memory = new Map(); // key -> { count, resetAt }
const MEMORY_MAX_KEYS = 10_000;

function pruneMemory(now) {
  for (const [k, e] of memory) if (e.resetAt <= now) memory.delete(k);
  // Still full (a flood of distinct keys): drop the oldest entries.
  for (const k of memory.keys()) {
    if (memory.size < MEMORY_MAX_KEYS * 0.9) break;
    memory.delete(k);
  }
}

function memoryConsume(key, limit, windowSeconds, now = Date.now()) {
  let entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    if (memory.size >= MEMORY_MAX_KEYS) pruneMemory(now);
    entry = { count: 0, resetAt: now + windowSeconds * 1000 };
    memory.set(key, entry);
  }
  entry.count += 1;
  return { ok: entry.count <= limit, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
}

/** Tests only: forget the in-memory counters (the table is cleared separately). */
export function resetRateLimitMemory() {
  memory.clear();
}

// ------------------------------------------------------------------- database

/**
 * Count one hit against every rule; { ok, retryAfter } where ok is false if ANY
 * rule is over its limit. rules: [{ key, limit, windowSeconds }].
 */
export async function consume(rules) {
  let ok = true;
  let retryAfter = 0;
  for (const r of rules) {
    const m = memoryConsume(r.key, r.limit, r.windowSeconds);
    if (!m.ok) {
      ok = false;
      retryAfter = Math.max(retryAfter, m.retryAfter);
    }
  }
  // Already refused locally: don't spend a database write on it.
  if (!ok) return { ok, retryAfter };

  try {
    const { rows } = await query(
      `INSERT INTO auth_rate_limits AS r (key, count, window_start, window_seconds)
       SELECT k, 1, now(), w FROM unnest($1::text[], $2::int[]) AS t(k, w)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN r.window_start <= now() - make_interval(secs => excluded.window_seconds)
                      THEN 1 ELSE r.count + 1 END,
         window_start = CASE WHEN r.window_start <= now() - make_interval(secs => excluded.window_seconds)
                             THEN now() ELSE r.window_start END,
         window_seconds = excluded.window_seconds
       RETURNING key, count,
         GREATEST(1, CEIL(EXTRACT(EPOCH FROM
           (window_start + make_interval(secs => window_seconds) - now()))))::int AS retry_after`,
      [rules.map((r) => r.key), rules.map((r) => r.windowSeconds)],
    );
    const byKey = new Map(rows.map((row) => [row.key, row]));
    for (const r of rules) {
      const row = byKey.get(r.key);
      if (row && Number(row.count) > r.limit) {
        ok = false;
        retryAfter = Math.max(retryAfter, Number(row.retry_after) || r.windowSeconds);
      }
    }
    // Expired counters are useless; sweep them now and then.
    if (Math.random() < 0.01) {
      await query(`DELETE FROM auth_rate_limits WHERE window_start < now() - interval '1 day'`);
    }
  } catch (err) {
    // The in-memory layer above still applies, so this is not "fail open".
    console.error('rate limit table unavailable (memory limits only)', err?.message);
  }
  return { ok, retryAfter };
}

export function rateLimitError(retryAfter, message = 'Too many requests. Please wait a moment and try again.') {
  const seconds = Math.max(1, Math.ceil(retryAfter || 1));
  return new HttpError(429, message, { code: 'RATE_LIMITED', retryAfter: seconds }, { 'Retry-After': seconds });
}

/** Count against `rules`; throw a 429 (with Retry-After) when over. */
export async function enforce(rules, message) {
  const { ok, retryAfter } = await consume(rules);
  if (!ok) throw rateLimitError(retryAfter, message);
}

/** Count this attempt; true if still within the limit. */
export async function withinLimit(key, limit, windowSeconds) {
  return (await consume([{ key, limit, windowSeconds }])).ok;
}

/** A rule from LIMITS bound to a key. */
export const rule = (name, id) => ({ key: `${name}:${hashKey(id)}`, ...LIMITS[name] });

// ----------------------------------------------------- request-level helpers

function hasCredentials(req) {
  const h = req.headers || {};
  if (h.authorization || h.Authorization) return true;
  return typeof h.cookie === 'string' && /(?:^|;\s*)rf_session=/.test(h.cookie);
}

/** route() calls this first: requests with no credentials are limited per IP, in memory. */
export function anonymousRequestAllowed(req) {
  if (hasCredentials(req)) return;
  const { limit, windowSeconds } = LIMITS.anonymousPerIp;
  const m = memoryConsume(`anon:${clientIp(req)}`, limit, windowSeconds);
  if (!m.ok) throw rateLimitError(m.retryAfter);
}

/** A request presented credentials that did not check out. 429 once an IP has too many. */
export async function noteAuthFailure(req) {
  await enforce([rule('authFailuresPerIp', clientIp(req))], 'Too many failed sign-in attempts. Try again in a few minutes.');
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Per-account budget for an authenticated request. */
export async function enforceAccountLimits(req, accountKey, kind = 'user') {
  const rules =
    kind === 'room'
      ? [rule('roomRequests', accountKey)]
      : [rule('userRequests', accountKey), ...(WRITE_METHODS.has(req.method) ? [rule('userWrites', accountKey)] : [])];
  await enforce(rules);
}
