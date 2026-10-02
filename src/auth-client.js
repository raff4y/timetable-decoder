// Front-end auth module. Pages import this and never touch Neon Auth or tokens.
// Contract: docs/ARCHITECTURE.md ("Front-end auth module").
//
// Every function resolves to a result object and does not throw for expected
// failures:  { ok: true, ...data }  |  { ok: false, error: { code, message } }
//
// Wraps the Neon Auth (Managed Better Auth) browser SDK, `@neondatabase/auth`,
// created from VITE_NEON_AUTH_URL. The SDK is imported lazily so pages that only
// need the guards stay light, and so tests can inject a fake client with
// __setAuthClientForTests().

const API_BASE = '/api';
const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ERROR_CODES = [
  'INVALID_CREDENTIALS',
  'EMAIL_TAKEN',
  'WEAK_PASSWORD',
  'INVALID_EMAIL',
  'EMAIL_NOT_VERIFIED', // addition: sign-in blocked until the email is verified
  'ACCOUNT_REVOKED', // addition: an admin revoked this account's access
  'RESET_TOKEN_INVALID',
  'RATE_LIMITED',
  'NETWORK',
  'UNKNOWN',
];

const MESSAGES = {
  INVALID_CREDENTIALS: 'Incorrect email or password.',
  EMAIL_TAKEN: 'An account with that email already exists. Try signing in instead.',
  WEAK_PASSWORD: `Use a password of at least ${MIN_PASSWORD} characters.`,
  INVALID_EMAIL: 'Enter a valid email address.',
  EMAIL_NOT_VERIFIED: 'Verify your email address first: check your inbox for the verification link.',
  ACCOUNT_REVOKED: 'Your access has been revoked by an admin. Contact your timetable admin if you think this is a mistake.',
  RESET_TOKEN_INVALID: 'This reset link is invalid or has expired. Request a new one.',
  RATE_LIMITED: 'Too many attempts. Please wait a few minutes and try again.',
  NETWORK: 'Could not reach the server. Check your connection and try again.',
  UNKNOWN: 'Something went wrong. Please try again.',
};

const fail = (code, message) => ({ ok: false, error: { code, message: message || MESSAGES[code] } });

// ---------------------------------------------------------------- SDK client

let clientPromise = null;

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const url = import.meta.env?.VITE_NEON_AUTH_URL;
      if (!url) throw Object.assign(new Error('VITE_NEON_AUTH_URL is not set'), { code: 'CONFIG' });
      const { createAuthClient } = await import('@neondatabase/auth');
      return createAuthClient(url);
    })();
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

/** Tests only: inject a fake SDK client (or null to reset). */
export function __setAuthClientForTests(client) {
  clientPromise = client ? Promise.resolve(client) : null;
  tokenCache = null;
}

/** Map a Better Auth / SDK error object to one of our codes. */
export function mapAuthError(err, fallback = 'UNKNOWN') {
  if (!err) return fail(fallback);
  if (err.code === 'CONFIG') return fail('UNKNOWN', 'Sign-in is not configured for this site yet.');
  const code = String(err.code || err.error?.code || '').toUpperCase();
  const msg = String(err.message || '');
  const status = Number(err.status ?? err.statusCode ?? 0);

  if (/INVALID_ORIGIN/.test(code) || /invalid origin/i.test(msg)) return fail('UNKNOWN', ORIGIN_MESSAGE);
  if (status === 429 || /RATE|TOO_MANY/.test(code)) return fail('RATE_LIMITED');
  if (/INVALID_EMAIL_OR_PASSWORD|INVALID_PASSWORD|INVALID_CREDENTIALS|USER_NOT_FOUND/.test(code)) return fail('INVALID_CREDENTIALS');
  if (/EMAIL_NOT_VERIFIED/.test(code)) return fail('EMAIL_NOT_VERIFIED');
  if (/USER_ALREADY_EXISTS|EMAIL_TAKEN|ALREADY_EXISTS/.test(code)) return fail('EMAIL_TAKEN');
  if (/PASSWORD_TOO_SHORT|PASSWORD_TOO_LONG|WEAK_PASSWORD/.test(code)) return fail('WEAK_PASSWORD');
  if (/INVALID_EMAIL/.test(code)) return fail('INVALID_EMAIL');
  if (/INVALID_TOKEN|TOKEN_EXPIRED|RESET_TOKEN/.test(code)) return fail('RESET_TOKEN_INVALID');
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(msg)) return fail('NETWORK');
  if (/invalid (email|password)/i.test(msg) && /password/i.test(msg)) return fail('INVALID_CREDENTIALS');
  if (/already (exists|registered)/i.test(msg)) return fail('EMAIL_TAKEN');
  if (/password.*(short|long|weak)/i.test(msg)) return fail('WEAK_PASSWORD');
  if (/not verified/i.test(msg)) return fail('EMAIL_NOT_VERIFIED');
  if (status === 401) return fail('INVALID_CREDENTIALS');
  return fail(fallback);
}

// Neon Auth refuses sign-ins from a domain missing from its trusted domains
// (Neon console -> Auth -> Configuration -> Domains).
const ORIGIN_MESSAGE = 'Sign-in is not enabled for this web address yet. Contact your timetable admin.';

// The SDK throws (rather than returns) some server refusals, e.g. INVALID_ORIGIN.
function networkOrUnknown(err) {
  if (/invalid origin/i.test(String(err?.message))) return fail('UNKNOWN', ORIGIN_MESSAGE);
  if (err instanceof TypeError || /fetch|network/i.test(String(err?.message))) return fail('NETWORK');
  return fail('UNKNOWN');
}

// -------------------------------------------------------------------- tokens

let tokenCache = null; // { token, exp (ms) }

function jwtExpiryMs(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')));
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** Fresh-enough JWT for our API, or null when not signed in. */
async function getToken({ force = false } = {}) {
  if (!force && tokenCache && tokenCache.exp - Date.now() > 30_000) return tokenCache.token;
  let client;
  try {
    client = await getClient();
  } catch {
    return null;
  }
  try {
    let token = null;
    if (typeof client.token === 'function') {
      const res = await client.token();
      token = res?.data?.token ?? null;
    }
    if (!token && typeof client.getSession === 'function') {
      const res = await client.getSession();
      token = res?.data?.session?.access_token ?? null;
    }
    if (!token) {
      tokenCache = null;
      return null;
    }
    tokenCache = { token, exp: jwtExpiryMs(token) || Date.now() + 60_000 };
    return token;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------- fetch

function isRawBody(body) {
  return (
    typeof body === 'string' ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
    (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body)))
  );
}

function statusToCode(status) {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 413) return 'TOO_LARGE';
  if (status === 422) return 'INVALID';
  if (status === 429) return 'RATE_LIMITED';
  return status >= 500 ? 'SERVER' : 'UNKNOWN';
}

/**
 * fetch() against /api with the signed-in user's token attached.
 *   apiFetch('/timetables')                       // '/api' is added if missing
 *   apiFetch('/schedules/3', { method: 'PUT', body: { sectionKeys: [] } })
 * A plain-object `body` is sent as JSON; strings, Blobs, ArrayBuffers, FormData
 * are sent as-is (e.g. an xlsx upload with headers { 'X-Filename': name }).
 * Resolves (never throws) to { ok, status, data, error }:
 *   data  = parsed JSON body (or null); error = { code, message } when !ok.
 * A 401 triggers one token refresh and a retry.
 * If the server says this account was revoked or signed out by an admin
 * (ACCOUNT_REVOKED / SESSION_REVOKED), the browser is signed out and sent to the
 * login page; the result is still returned for callers that are mid-flight.
 */
export async function apiFetch(path, init = {}) {
  const res = await rawApiFetch(path, init);
  if (REVOKED_CODES.has(res.error?.code)) {
    await forceSignOut('revoked');
    // In a browser the page is navigating away: never settle, so the caller
    // can't race the redirect with one of its own (e.g. to ?next=...).
    if (typeof document !== 'undefined') return new Promise(() => {});
  }
  return res;
}

const REVOKED_CODES = new Set(['ACCOUNT_REVOKED', 'SESSION_REVOKED']);

let forcedOut = false;

// Where this page sends signed-out people: '/login.html', or '/cms/login' on the
// CMS. Set by requireUser({ loginPath }).
let loginPage = '/login.html';

/** Sign out locally and land on the login page with a reason ('revoked' | 'expired'). */
async function forceSignOut(reason) {
  if (forcedOut) return;
  forcedOut = true;
  stopSessionWatch();
  await signOut();
  if (typeof location !== 'undefined') location.replace(`${loginPage}?reason=${encodeURIComponent(reason)}`);
}

// ------------------------------------------------------------- admin hint

// A UI hint only, never a permission: "an admin was signed in on this browser".
// The CMS reads it before any network call so a signed-out visitor goes
// straight to /cms/login instead of seeing the CMS loading screen first. The
// server still checks the admin role on every request.
const ADMIN_HINT_KEY = 'ttd.admin';

function rememberRole(user) {
  try {
    if (user?.role === 'admin' && user.status === 'approved') localStorage.setItem(ADMIN_HINT_KEY, '1');
    else localStorage.removeItem(ADMIN_HINT_KEY);
  } catch {
    /* storage blocked: the CMS just takes the slower path */
  }
}

/** True when an admin was last seen signed in on this browser. */
export function adminHint() {
  try {
    return localStorage.getItem(ADMIN_HINT_KEY) === '1';
  } catch {
    return true; // can't tell: let the real session check decide
  }
}

/** apiFetch without the revoked-account sign-out (used by signIn / signUp). */
async function rawApiFetch(path, init = {}) {
  const url = path.startsWith(`${API_BASE}/`) || path === API_BASE ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;

  const send = async (token) => {
    const headers = new Headers(init.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    let body = init.body;
    if (body !== undefined && body !== null && !isRawBody(body)) {
      body = JSON.stringify(body);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }
    return fetch(url, { ...init, headers, body, credentials: 'same-origin' });
  };

  let res;
  try {
    res = await send(await getToken());
    if (res.status === 401) {
      const fresh = await getToken({ force: true });
      if (fresh) res = await send(fresh);
    }
  } catch {
    return { ok: false, status: 0, data: null, error: { code: 'NETWORK', message: MESSAGES.NETWORK } };
  }

  let data = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.ok) return { ok: true, status: res.status, data, error: null };
  const code = data?.details?.code || statusToCode(res.status);
  const message = data?.error || MESSAGES.UNKNOWN;
  return { ok: false, status: res.status, data, error: { code, message } };
}

// --------------------------------------------------------------------- users

/** The signed-in user (GET /api/me shape) or null. */
export async function getCurrentUser() {
  const res = await apiFetch('/me');
  const user = res.ok && res.data?.user ? res.data.user : null;
  if (user || res.status === 401) rememberRole(user);
  return user;
}

function validateEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

export async function signIn({ email, password } = {}) {
  if (!validateEmail(email)) return fail('INVALID_EMAIL');
  if (!password) return fail('INVALID_CREDENTIALS');
  let client;
  try {
    client = await getClient();
  } catch (err) {
    return mapAuthError(err);
  }
  try {
    const { error } = await client.signIn.email({ email: email.trim(), password });
    if (error) return mapAuthError(error, 'INVALID_CREDENTIALS');
  } catch (err) {
    return networkOrUnknown(err);
  }
  tokenCache = null;
  forcedOut = false;
  const res = await rawApiFetch('/me');
  if (res.ok && res.data?.user) {
    rememberRole(res.data.user);
    return { ok: true, user: res.data.user };
  }
  if (REVOKED_CODES.has(res.error?.code)) {
    // Don't leave a Neon session behind for an account that may not use it.
    await signOut();
    return fail('ACCOUNT_REVOKED');
  }
  if (res.error?.code === 'RATE_LIMITED') return fail('RATE_LIMITED');
  if (res.error?.code === 'EMAIL_NOT_VERIFIED') return fail('EMAIL_NOT_VERIFIED');
  if (res.error?.code === 'NETWORK') return fail('NETWORK');
  return fail('UNKNOWN');
}

/**
 * Sign up, then load /api/me so the app_users row exists and `user.status` is
 * accurate ('pending', or 'approved' when the email was pre-added).
 * If the Neon Auth project requires email verification there is no session yet:
 * the result is { ok: true, user: <provisional pending user>, needsVerification: true }
 * and the page should tell the person to check their inbox.
 */
export async function signUp({ name, email, password } = {}) {
  if (!validateEmail(email)) return fail('INVALID_EMAIL');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return fail('WEAK_PASSWORD');
  const cleanName = String(name || '').trim() || email.trim().split('@')[0];
  let client;
  try {
    client = await getClient();
  } catch (err) {
    return mapAuthError(err);
  }
  try {
    const { error } = await client.signUp.email({ name: cleanName, email: email.trim(), password });
    if (error) return mapAuthError(error);
  } catch (err) {
    return networkOrUnknown(err);
  }
  tokenCache = null;
  forcedOut = false;
  const me = await rawApiFetch('/me');
  const user = me.ok ? me.data?.user : null;
  if (user) return { ok: true, user };
  if (REVOKED_CODES.has(me.error?.code)) {
    await signOut();
    return fail('ACCOUNT_REVOKED');
  }
  return {
    ok: true,
    needsVerification: true,
    user: {
      id: null,
      email: email.trim().toLowerCase(),
      displayName: cleanName,
      role: 'student',
      status: 'pending',
      source: 'signup',
    },
  };
}

export async function resendVerificationEmail({ email } = {}) {
  if (!validateEmail(email)) return fail('INVALID_EMAIL');
  try {
    const client = await getClient();
    const { error } = await client.sendVerificationEmail({
      email: email.trim(),
      callbackURL: `${location.origin}/login.html`,
    });
    if (error) return mapAuthError(error);
    return { ok: true };
  } catch (err) {
    return networkOrUnknown(err);
  }
}

export async function signOut() {
  stopSessionWatch();
  tokenCache = null;
  rememberRole(null);
  try {
    const client = await getClient();
    await client.signOut();
  } catch {
    /* already signed out / offline: nothing more to do */
  }
  return { ok: true };
}

/**
 * Start a password reset through OUR endpoint (never straight to Neon Auth), so
 * the server can refuse pre-added accounts. Always { ok: true } for a well-formed
 * email (generic message: "If that account can reset its password, a link is on its
 * way."). The emailed link lands on `redirectTo`
 * (default `<origin>/login.html?view=reset`) with `?token=` appended.
 */
export async function requestPasswordReset({ email, redirectTo } = {}) {
  if (!validateEmail(email)) return fail('INVALID_EMAIL');
  const target = redirectTo || `${location.origin}/login.html?view=reset`;
  const res = await apiFetch('/auth/password-reset', { method: 'POST', body: { email: email.trim(), redirectTo: target } });
  if (res.ok) return { ok: true };
  if (res.status === 429) return fail('RATE_LIMITED');
  if (res.status === 422) return fail('INVALID_EMAIL');
  if (res.error?.code === 'NETWORK') return fail('NETWORK');
  return fail('UNKNOWN');
}

export async function resetPassword({ token, newPassword } = {}) {
  if (!token) return fail('RESET_TOKEN_INVALID');
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD) return fail('WEAK_PASSWORD');
  try {
    const client = await getClient();
    const { error } = await client.resetPassword({ newPassword, token });
    if (error) return mapAuthError(error, 'RESET_TOKEN_INVALID');
    return { ok: true };
  } catch (err) {
    return networkOrUnknown(err);
  }
}

// ----------------------------------------------------------------- redirects

/** `next` is honoured only when it is a same-origin path ("/x", not "//host" or "http://..."). */
export function safeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  try {
    const u = new URL(next, location.origin);
    return u.origin === location.origin ? u.pathname + u.search + u.hash : null;
  } catch {
    return null;
  }
}

/** Where the login page should go after signIn/signUp: `?next=` if safe, else by status. */
export function postSignInDestination(user, search = location.search) {
  const next = safeNext(new URLSearchParams(search).get('next'));
  if (next && user?.status === 'approved') return next;
  return user?.status === 'approved' ? '/app.html' : '/pending.html';
}

/**
 * Page guard. Redirects and resolves null, or resolves the user.
 *   not signed in            -> <loginPath>?next=<this page> (default /login.html)
 *   not approved             -> /pending.html (unless allowPending)
 *   role 'admin' but student -> /app.html
 */
export async function requireUser({ role, allowPending = false, loginPath = '/login.html' } = {}) {
  loginPage = loginPath;
  const user = await getCurrentUser();
  if (!user) {
    const here = location.pathname + location.search + (location.hash || '');
    location.replace(`${loginPath}?next=${encodeURIComponent(here)}`);
    return null;
  }
  if (user.status !== 'approved' && !allowPending) {
    location.replace('/pending.html');
    return null;
  }
  if (role === 'admin' && user.role !== 'admin') {
    location.replace('/app.html');
    return null;
  }
  if (typeof document !== 'undefined') watchSession({ role, allowPending });
  return user;
}

// ------------------------------------------------------------ session watch

const WATCH_MS = 60_000;
let watch = null;

/**
 * Keep re-checking /api/me while a gated page is open (every minute, and when
 * the tab becomes visible again), so a revoked user is signed out even on a tab
 * they are not touching. requireUser() starts this; pages need not call it.
 *   revoked / signed out by admin -> sign out, <login page>?reason=revoked
 *   no longer signed in           -> <login page>?reason=expired
 *   no longer approved            -> /pending.html (unless allowPending)
 *   no longer admin (admin pages) -> /app.html
 * Network errors and 429s are ignored: the next tick tries again.
 */
export function watchSession({ role, allowPending = false } = {}) {
  stopSessionWatch();
  const check = async () => {
    const res = await apiFetch('/me'); // handles the revoked case itself
    if (forcedOut) return;
    if (res.status === 401) return forceSignOut('expired');
    if (!res.ok || !res.data?.user) return;
    const user = res.data.user;
    if (user.status !== 'approved' && !allowPending) {
      stopSessionWatch();
      location.replace('/pending.html');
    } else if (role === 'admin' && user.role !== 'admin') {
      stopSessionWatch();
      location.replace('/app.html');
    }
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') check();
  };
  document.addEventListener('visibilitychange', onVisible);
  watch = { timer: setInterval(check, WATCH_MS), onVisible };
}

export function stopSessionWatch() {
  if (!watch) return;
  clearInterval(watch.timer);
  document.removeEventListener('visibilitychange', watch.onVisible);
  watch = null;
}
