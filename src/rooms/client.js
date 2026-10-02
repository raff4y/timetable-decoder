// Free Room Finder browser client. Its login is separate from the timetable
// tool's (src/auth-client.js is not used here): the session is an HttpOnly
// cookie scoped to /api/rooms, so this file never sees a token.
//
// Every function resolves (never throws) to { ok, status, data, error } or a
// value derived from it; error = { code, message }.

const BASE = '/api/rooms';
export const LOGIN_PATH = '/rooms/login.html';
export const APP_PATH = '/rooms/';

const NETWORK = { code: 'NETWORK', message: 'Can’t reach the server. Check your connection and try again.' };

async function call(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, status: 0, data: null, error: NETWORK };
  }
  let data = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.ok) return { ok: true, status: res.status, data, error: null };
  return {
    ok: false,
    status: res.status,
    data,
    error: {
      code: data?.details?.code || (res.status === 401 ? 'ROOMS_SIGNED_OUT' : res.status >= 500 ? 'SERVER' : 'UNKNOWN'),
      message: data?.error || 'Something went wrong. Please try again.',
    },
  };
}

/** The signed-in account ({ id, username, displayName }) or null. */
export async function getAccount() {
  const res = await call('/session');
  return res.ok ? res.data.account : null;
}

export function signIn({ username, password }) {
  return call('/session', { method: 'POST', body: { username, password } });
}

export function signOut() {
  return call('/session', { method: 'DELETE' });
}

export function changePassword({ currentPassword, newPassword }) {
  return call('/session', { method: 'PATCH', body: { currentPassword, newPassword } });
}

export function loadRoomData() {
  return call('/data');
}

/** `next` is honoured only for same-origin paths inside the Room Finder. */
export function safeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/rooms/') || next.startsWith('//')) return null;
  try {
    const u = new URL(next, location.origin);
    return u.origin === location.origin && u.pathname.startsWith('/rooms/') ? u.pathname + u.search + u.hash : null;
  } catch {
    return null;
  }
}

/** Page guard: resolves the account, or redirects to the Room Finder login and resolves null. */
export async function requireAccount() {
  const account = await getAccount();
  if (!account) {
    location.replace(`${LOGIN_PATH}?next=${encodeURIComponent(location.pathname + location.search)}`);
    return null;
  }
  return account;
}
