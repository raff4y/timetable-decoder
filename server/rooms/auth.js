// Free Room Finder identity: its own accounts, passwords and sessions.
//
// This is deliberately NOT the Neon Auth login the timetable tool uses (see
// server/auth.js). The Room Finder is invite-only: there is no sign-up, an admin
// creates every account (scripts/room-accounts.mjs or /api/admin/room-accounts),
// and an app_users login does not open it.
//
// * Passwords: scrypt (node:crypto), stored as
//   `scrypt$<N>$<r>$<p>$<salt b64>$<key b64>` so the cost can be raised later
//   without invalidating existing hashes.
// * Sessions: a random 256-bit token in an HttpOnly, SameSite=Strict cookie
//   scoped to /api/rooms; only its SHA-256 lives in room_finder_sessions. Every
//   request re-reads the account, so disabling it takes effect immediately, and a
//   password reset deletes the account's sessions.
// * CSRF: the cookie is SameSite=Strict, and state-changing calls must be JSON
//   (a cross-site form cannot send application/json without a CORS preflight).

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { query } from '../db.js';
import { HttpError } from '../http.js';
import { enforceAccountLimits, noteAuthFailure } from '../rate-limit.js';

const scrypt = promisify(crypto.scrypt);

export const SESSION_COOKIE = 'rf_session';
export const COOKIE_PATH = '/api/rooms';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

// ------------------------------------------------------------------ passwords

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  // Refuse absurd parameters rather than letting a bad row burn CPU/memory.
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) {
    return false;
  }
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (!salt.length || !expected.length) return false;
  const key = await scrypt(String(password), salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
  return crypto.timingSafeEqual(key, expected);
}

// Compared against when the username does not exist, so a miss costs the same
// time as a wrong password and response timing does not reveal which accounts exist.
let dummyHash = null;
function getDummyHash() {
  if (!dummyHash) dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

/** Throws a 422 WEAK_PASSWORD unless the password is acceptable. */
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new HttpError(422, `Use a password of at least ${MIN_PASSWORD} characters.`, { code: 'WEAK_PASSWORD' });
  }
  if (password.length > MAX_PASSWORD) {
    throw new HttpError(422, `Use a password of at most ${MAX_PASSWORD} characters.`, { code: 'WEAK_PASSWORD' });
  }
}

// No 0/O, 1/l/I: these get read aloud or copied off a screen.
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random 16-character password for new accounts and admin resets. */
export function generatePassword(length = 16) {
  let out = '';
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

// -------------------------------------------------------------------- lookups

/** The account row if the username and password match, else null. Status is not checked here. */
export async function checkCredentials(username, password) {
  const { rows } = await query('SELECT * FROM room_finder_accounts WHERE username = $1', [username]);
  const account = rows[0];
  const ok = await verifyPassword(password, account ? account.password_hash : await getDummyHash());
  return account && ok ? account : null;
}

// ------------------------------------------------------------------- sessions

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Create a session for the account; returns the raw token for the cookie. */
export async function createSession(accountId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO room_finder_sessions (token_hash, account_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [hashToken(token), accountId, SESSION_TTL_SECONDS],
  );
  // Opportunistic cleanup; sign-ins are rare enough that this stays cheap.
  await query('DELETE FROM room_finder_sessions WHERE expires_at < now()');
  return token;
}

export async function deleteSession(token) {
  if (token) await query('DELETE FROM room_finder_sessions WHERE token_hash = $1', [hashToken(token)]);
}

export function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

export const sessionToken = (req) => readCookie(req, SESSION_COOKIE);

/**
 * { account, token } for a valid session on an active account, else null.
 * A cookie that does not check out counts against the IP (429 after too many);
 * a valid one counts against the account's request budget.
 */
export async function getRoomSession(req) {
  const token = sessionToken(req);
  if (!token) return null;
  if (token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    await noteAuthFailure(req);
    return null;
  }
  const { rows } = await query(
    `SELECT a.* FROM room_finder_sessions s
       JOIN room_finder_accounts a ON a.id = s.account_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND a.status = 'active'`,
    [hashToken(token)],
  );
  if (!rows[0]) {
    await noteAuthFailure(req);
    return null;
  }
  await enforceAccountLimits(req, `room:${rows[0].id}`, 'room');
  return { account: rows[0], token };
}

/** The signed-in Room Finder account, or a 401. */
export async function requireRoomAccount(req) {
  const session = await getRoomSession(req);
  if (!session) throw new HttpError(401, 'Sign in to the Room Finder', { code: 'ROOMS_SIGNED_OUT' });
  return session.account;
}

// -------------------------------------------------------------------- cookies

function isSecureRequest(req) {
  const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || Boolean(req.socket?.encrypted) || process.env.VERCEL === '1';
}

function cookie(req, value, maxAge) {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

export function setSessionCookie(req, res, token) {
  res.setHeader('Set-Cookie', cookie(req, token, SESSION_TTL_SECONDS));
}

export function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', cookie(req, '', 0));
}

/** State-changing calls must be JSON (see CSRF note at the top). */
export function requireJsonRequest(req) {
  const type = String(req.headers?.['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) {
    throw new HttpError(415, 'Send the request as application/json');
  }
}
