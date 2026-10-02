// POST /api/auth/password-reset { email, redirectTo? } -> 200 { ok: true } ALWAYS.
//
// This is the only way the UI starts a password reset. We ask Neon Auth to send
// the reset email only when the email does NOT belong to a pre-added account
// (app_users.source = 'preadded'; those are handled by an admin). The response
// and (approximately) the timing are identical in both cases, so nothing leaks
// about which emails exist or how they were created.
//
// The reset link Neon emails lands on `redirectTo` (default
// `<origin>/login.html?view=reset`) with `?token=<token>` appended by Better Auth.
//
// Throttled per IP+email and per IP (fixed window, stored in auth_rate_limits so
// it holds across serverless instances). Over the limit -> 429 RATE_LIMITED,
// which depends only on the caller's request count, not on the account.

import { HttpError, readJson, route, sendJson } from '../../server/http.js';
import { query } from '../../server/db.js';
import { authConfig } from '../../server/auth.js';
import { clientIp, enforce, hashKey as hash } from '../../server/rate-limit.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WINDOW_SECONDS = 15 * 60;
const PER_EMAIL_LIMIT = 3;
// Generous enough for a campus behind one NAT address.
const PER_IP_LIMIT = 30;
const PER_EMAIL_GLOBAL_LIMIT = 5; // per hour

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const originOf = (s) => {
  try {
    return new URL(s.includes('://') ? s : `https://${s}`).origin;
  } catch {
    return '';
  }
};

/**
 * Origins a reset link may point at. On Vercel these come from configuration
 * only (APP_ORIGIN, then Vercel's own deployment URLs), never from request
 * headers: a forged Host / X-Forwarded-Host must not be able to make Neon email
 * a reset token to someone else's site. Off Vercel (local dev) the Host header
 * is the only thing we have, and only localhost-style setups run there.
 */
function allowedOrigins(req) {
  const list = (process.env.APP_ORIGIN || '').split(',').map((s) => originOf(s.trim())).filter(Boolean);
  if (process.env.VERCEL === '1') {
    for (const v of [process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_URL]) {
      if (v) list.push(originOf(v));
    }
  } else if (req.headers.host) {
    list.push(`${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}`);
  }
  return [...new Set(list.filter(Boolean))];
}

/** Only redirect back to an allowed origin; otherwise our own login page. */
function pickRedirect(req, redirectTo) {
  const allowed = allowedOrigins(req);
  try {
    const u = new URL(redirectTo);
    if (allowed.includes(u.origin)) return { url: u.toString(), origin: u.origin };
  } catch {
    /* fall through */
  }
  const own = allowed[0] || '';
  return { url: `${own}/login.html?view=reset`, origin: own };
}

async function sendNeonResetEmail(email, redirect) {
  const { base } = authConfig();
  if (!base) {
    console.error('password-reset: NEON_AUTH_URL not set; no email sent');
    return;
  }
  try {
    const res = await fetch(`${base}/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: redirect.origin },
      body: JSON.stringify({ email, redirectTo: redirect.url }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error('password-reset: Neon Auth responded', res.status);
  } catch (err) {
    console.error('password-reset: Neon Auth request failed', err?.message);
  }
}

export default route({
  POST: async (req, res) => {
    const started = Date.now();
    const body = await readJson(req);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(422, 'Enter a valid email address.');

    const ip = clientIp(req);
    // Per IP+email, per IP, and per email from anywhere (so rotating IPs can't
    // be used to flood one person's inbox).
    await enforce(
      [
        { key: `pwreset:e:${hash(`${ip}|${email}`)}`, limit: PER_EMAIL_LIMIT, windowSeconds: WINDOW_SECONDS },
        { key: `pwreset:i:${hash(ip)}`, limit: PER_IP_LIMIT, windowSeconds: WINDOW_SECONDS },
        { key: `pwreset:g:${hash(email)}`, limit: PER_EMAIL_GLOBAL_LIMIT, windowSeconds: WINDOW_SECONDS * 4 },
      ],
      'Too many requests. Try again in a few minutes.',
    );

    const { rows } = await query('SELECT source FROM app_users WHERE email = $1', [email]);
    const preadded = rows[0]?.source === 'preadded';
    if (!preadded) {
      await sendNeonResetEmail(email, pickRedirect(req, body.redirectTo));
    }

    // Equalise timing between the refused and the sent case.
    const floor = Number(process.env.RESET_MIN_MS ?? 700);
    const wait = floor - (Date.now() - started);
    if (wait > 0) await sleep(wait);

    sendJson(res, 200, { ok: true });
  },
});
