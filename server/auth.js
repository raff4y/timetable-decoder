// Server-side identity: verify the caller's Neon Auth JWT, then load / create /
// link the matching `app_users` row (role + approval status).
//
// INTEGRATION DECISION (researched against the Neon docs, 2026-10)
// ---------------------------------------------------------------
// * "Neon Auth" today is *Managed Better Auth* (Better Auth ~1.4, REST service in
//   front of the project's own Neon database). The earlier Stack Auth based
//   product is the deprecated "auth-legacy". Users/sessions/accounts live in the
//   `neon_auth` schema (`neon_auth."user"` has id, email, "emailVerified", ...).
// * Browser: `createAuthClient(NEON_AUTH_URL)` from `@neondatabase/auth`
//   (signUp.email / signIn.email / signOut / token() / requestPasswordReset /
//   resetPassword). The session itself is an HttpOnly cookie on the Neon Auth
//   host; for our own /api calls the client asks `authClient.token()` for a
//   short-lived (15 min) EdDSA JWT and sends it as `Authorization: Bearer`.
// * Server (here): verify that JWT with `jose` against
//   `${NEON_AUTH_URL}/.well-known/jwks.json`, issuer = the origin of NEON_AUTH_URL.
//   Claims: sub (= neon_auth.user.id), email, emailVerified, role ("authenticated").
//   Env overrides for tests/other setups: NEON_AUTH_JWKS_URL, NEON_AUTH_ISSUER.
// * Email verification can be *required* (email/password config
//   `require_email_verification: true`, console toggle "Verify at Sign-up"), in
//   which case nobody gets a session until the address is verified. We still
//   check the `emailVerified` claim before linking (defence in depth).
// * There is NO server-side "create user with password / invite" call: the
//   management API's create-user takes only email + name. So pre-added people sign
//   up themselves with the pre-added email, verify it, and that verified sign-in
//   links them to their pre-approved row.
// * Neon Auth's own `request-password-reset` endpoint is public and has no
//   per-user switch, so it cannot be locked down for pre-added accounts. Our
//   enforcement is `POST /api/auth/password-reset` (see api/auth/password-reset.js)
//   plus the UI never calling Neon's endpoint directly. Residual risk documented in
//   docs/ARCHITECTURE.md.
//
// Sources:
//   https://neon.com/docs/auth/overview
//   https://neon.com/docs/auth/authentication-flow
//   https://neon.com/docs/auth/guides/plugins/jwt
//   https://neon.com/docs/auth/guides/email-verification
//   https://neon.com/docs/auth/guides/password-reset
//   https://neon.com/docs/reference/api/auth/update-neon-auth-email-and-password-config
//   https://neon.com/guides/react-neon-auth-hono   (jose + JWKS example)
//
// LINKING RULE (safe option chosen)
// ---------------------------------
// A sign-in is matched to an app_users row by auth_user_id first, then by email.
// An email match with a row that is not yet linked to this auth user is only
// accepted when Neon Auth reports the email as VERIFIED; otherwise the request is
// refused with 403 {code: 'EMAIL_NOT_VERIFIED'} (we cannot create a separate row
// because email is unique, and creating one would let an unverified signup squat on
// a pre-added address). An email with no row at all gets a new `pending` signup row.
// A verified re-sign-up after the old Neon account was deleted re-links the same row
// (that is how an admin "resets" the password of a pre-added account: delete the
// auth user in the Neon console, the person signs up again with the same email).

//
// CHECKS ON EVERY AUTHENTICATED REQUEST (in order; any failure stops it)
// ---------------------------------------------------------------------
//  1. Bearer token present and of sane size (no token -> 401, nothing else runs).
//  2. Signature against Neon's JWKS, allowed algorithms only, issuer, exp, iat
//     (not in the future, not older than MAX_TOKEN_AGE), sub + email present.
//     A bad token counts against the caller's IP (authFailuresPerIp -> 429).
//  3. Email verified (claim, or neon_auth.user as fallback) -> else 403.
//  4. Per-account rate limit (server/rate-limit.js) -> 429.
//  5. app_users row re-read from the database (never cached), so role/status
//     changes apply to the very next request.
//  6. Revocation: a token issued at or before app_users.sessions_revoked_at is
//     refused (401 SESSION_REVOKED), even though it has not expired.
//  7. Status: 'disabled' is refused everywhere, /api/me included
//     (403 ACCOUNT_REVOKED); anything but 'approved' is refused on data routes.
//  8. Role: admin routes re-check role = 'admin' from that same fresh row.
//
// REVOKING ACCESS (api/admin/users/[id].js, then endNeonSessions)
// ---------------------------------------------------------------
// Sets sessions_revoked_at = now() (check 6 kills every outstanding JWT at once)
// and deletes the person's Neon Auth sessions (neon_auth.session), so the
// browser cannot mint a fresh token without signing in again. If that delete
// fails, a disabled account is still locked out by check 7.

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { query, tx } from './db.js';
import { HttpError } from './http.js';
import { touchLastSeen } from './activity.js';
import { enforceAccountLimits, noteAuthFailure } from './rate-limit.js';

const ALGORITHMS = ['EdDSA', 'ES256', 'RS256'];
// Neon issues 15-minute tokens; anything claiming a longer life is refused.
const MAX_TOKEN_AGE = '1h';
const MAX_TOKEN_LENGTH = 8192;
const jwksCache = new Map();

function isProduction() {
  return process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
}

export function authConfig() {
  const base = (process.env.NEON_AUTH_URL || '').replace(/\/+$/, '');
  const jwksUrl = process.env.NEON_AUTH_JWKS_URL || (base ? `${base}/.well-known/jwks.json` : '');
  let issuer = process.env.NEON_AUTH_ISSUER || '';
  if (!issuer && base) {
    try {
      issuer = new URL(base).origin;
    } catch {
      issuer = '';
    }
  }
  return { base, jwksUrl, issuer };
}

function getJwks(url) {
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url), { cooldownDuration: 10_000 });
    jwksCache.set(url, jwks);
  }
  return jwks;
}

export function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/** True when the request carries an Authorization header of any kind. */
function presentsCredentials(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  return typeof header === 'string' && header.trim() !== '';
}

function assertSafeConfig({ jwksUrl, issuer }) {
  if (!jwksUrl || !issuer) {
    console.error('Neon Auth is not configured (set NEON_AUTH_URL, or NEON_AUTH_JWKS_URL + NEON_AUTH_ISSUER)');
    throw new HttpError(503, 'Authentication is not configured');
  }
  // Keys fetched over plain HTTP could be swapped in transit: refuse in production.
  if (isProduction() && !jwksUrl.startsWith('https://')) {
    console.error('NEON_AUTH_JWKS_URL must be https in production');
    throw new HttpError(503, 'Authentication is not configured');
  }
}

/** Verified Neon Auth identity from the request, or null if absent/invalid. */
export async function verifyIdentity(req) {
  const token = bearerToken(req);
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const config = authConfig();
  assertSafeConfig(config);
  let payload;
  try {
    ({ payload } = await jwtVerify(token, getJwks(config.jwksUrl), {
      issuer: config.issuer,
      algorithms: ALGORITHMS,
      requiredClaims: ['sub', 'iat', 'exp'],
      maxTokenAge: MAX_TOKEN_AGE,
      clockTolerance: 5,
    }));
  } catch {
    return null;
  }
  const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!sub || sub.length > 255 || !email || email.length > 254) return null;
  if (!Number.isFinite(payload.iat)) return null;

  let emailVerified = payload.emailVerified;
  if (typeof emailVerified !== 'boolean') emailVerified = await lookupEmailVerified(sub);
  return {
    authUserId: sub,
    email,
    emailVerified: emailVerified === true,
    name: typeof payload.name === 'string' ? payload.name.trim().slice(0, 200) : '',
    issuedAt: payload.iat,
  };
}

// Fallback when the token has no emailVerified claim: ask Neon's own table.
async function lookupEmailVerified(authUserId) {
  try {
    const { rows } = await query('SELECT "emailVerified" AS v FROM neon_auth."user" WHERE id::text = $1', [authUserId]);
    return rows[0]?.v === true;
  } catch {
    return false;
  }
}

function defaultName(identity) {
  return identity.name || identity.email.split('@')[0];
}

async function resolveInTx(client, identity) {
  const byAuth = await client.query('SELECT * FROM app_users WHERE auth_user_id = $1', [identity.authUserId]);
  if (byAuth.rows[0]) return byAuth.rows[0];

  const byEmail = await client.query('SELECT * FROM app_users WHERE email = $1 FOR UPDATE', [identity.email]);
  const existing = byEmail.rows[0];
  if (!existing) {
    const ins = await client.query(
      `INSERT INTO app_users (auth_user_id, email, display_name, role, status, source)
       VALUES ($1, $2, $3, 'student', 'pending', 'signup') RETURNING *`,
      [identity.authUserId, identity.email, defaultName(identity)],
    );
    return ins.rows[0];
  }

  if (!identity.emailVerified) {
    throw new HttpError(403, 'Verify your email address to continue.', { code: 'EMAIL_NOT_VERIFIED' });
  }
  const upd = await client.query(
    `UPDATE app_users
        SET auth_user_id = $1,
            display_name = CASE WHEN display_name = '' THEN $3 ELSE display_name END
      WHERE id = $2 RETURNING *`,
    [identity.authUserId, existing.id, defaultName(identity)],
  );
  return upd.rows[0];
}

/** Find / create / link the app_users row for a verified identity. */
export async function resolveAppUser(identity) {
  // Fast path for the common case (already linked): one plain query, no transaction.
  const linked = await query('SELECT * FROM app_users WHERE auth_user_id = $1', [identity.authUserId]);
  if (linked.rows[0]) return linked.rows[0];
  for (let attempt = 0; ; attempt++) {
    try {
      return await tx((client) => resolveInTx(client, identity));
    } catch (err) {
      // Two first requests racing to insert the same user: retry, we'll find it.
      if (err?.code === '23505' && attempt < 2) continue;
      throw err;
    }
  }
}

/** { identity, user } for an authenticated request, or null when not signed in. */
export async function getAuthContext(req) {
  if (!presentsCredentials(req)) return null;
  const identity = await verifyIdentity(req);
  if (!identity) {
    // Forged, expired, malformed: count it against the IP (429 after too many).
    await noteAuthFailure(req);
    return null;
  }
  // Only verified mailboxes get in. Otherwise anyone could sign up with someone
  // else's address and wait for an admin to approve "them".
  if (!identity.emailVerified) {
    throw new HttpError(403, 'Verify your email address to continue.', { code: 'EMAIL_NOT_VERIFIED' });
  }
  await enforceAccountLimits(req, `user:${identity.authUserId}`);

  const user = await resolveAppUser(identity);
  if (isRevoked(user, identity)) {
    throw new HttpError(401, 'You have been signed out. Please sign in again.', { code: 'SESSION_REVOKED' });
  }
  await touchLastSeen(user);
  return { identity, user };
}

/** Was this token issued at or before the user's last revocation? */
export function isRevoked(user, identity) {
  if (!user.sessions_revoked_at) return false;
  const revokedSec = Math.floor(new Date(user.sessions_revoked_at).getTime() / 1000);
  return !(identity.issuedAt > revokedSec);
}

/**
 * Second half of signing someone out everywhere (the first is setting
 * app_users.sessions_revoked_at = now(), which kills every JWT issued so far):
 * delete their Neon Auth sessions, so no new token can be minted without a
 * fresh sign-in. Best effort and outside any transaction, so a failure here (or
 * a missing neon_auth schema) cannot undo the revocation itself.
 */
export async function endNeonSessions(authUserId) {
  if (!authUserId) return false;
  try {
    await query('DELETE FROM neon_auth.session WHERE "userId"::text = $1', [authUserId]);
    return true;
  } catch (err) {
    // Not fatal: sessions_revoked_at already refuses every existing token.
    console.error('could not delete Neon Auth sessions', err?.message || err);
    return false;
  }
}

/**
 * Signed-in user. 401 if not signed in. A disabled (revoked) account is refused
 * everywhere with 403 ACCOUNT_REVOKED. Unless `allowPending`, the account must
 * be `approved` (403 otherwise); `allowPending` lets pending and rejected
 * through: it exists for /api/me and the pending page.
 */
export async function requireUser(req, { allowPending = false } = {}) {
  const ctx = await getAuthContext(req);
  if (!ctx) throw new HttpError(401, 'Sign in required');
  const { user } = ctx;
  if (user.status === 'disabled') {
    throw new HttpError(403, notApprovedMessage(user.status), { code: 'ACCOUNT_REVOKED', status: user.status });
  }
  if (!allowPending && user.status !== 'approved') {
    throw new HttpError(403, notApprovedMessage(user.status), { code: 'NOT_APPROVED', status: user.status });
  }
  return user;
}

export function requireApprovedUser(req) {
  return requireUser(req, { allowPending: false });
}

export async function requireAdmin(req) {
  const user = await requireUser(req, { allowPending: false });
  if (user.role !== 'admin') throw new HttpError(403, 'Admin access required', { code: 'NOT_ADMIN' });
  return user;
}

function notApprovedMessage(status) {
  switch (status) {
    case 'pending':
      return 'Your account is waiting for approval.';
    case 'rejected':
      return 'Your sign-up request was not approved.';
    case 'disabled':
      return 'Your access has been revoked by an admin.';
    default:
      return 'Your account is not approved.';
  }
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** The `user` shape from /api/me. */
export function toPublicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    source: row.source,
  };
}

/** Public shape plus admin-only fields. */
export function toAdminUser(row) {
  const out = {
    ...toPublicUser(row),
    createdAt: iso(row.created_at),
    approvedAt: iso(row.approved_at),
    lastSeenAt: iso(row.last_seen_at),
    sessionsRevokedAt: iso(row.sessions_revoked_at),
  };
  if (row.schedule_count !== undefined) out.scheduleCount = Number(row.schedule_count);
  return out;
}
