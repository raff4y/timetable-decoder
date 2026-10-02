// Free Room Finder session. Separate from the timetable tool's Neon Auth login:
// see server/rooms/auth.js.
//
// GET    /api/rooms/session                                  -> { account } | 401
// POST   /api/rooms/session { username, password }          -> { account } + session cookie
// PATCH  /api/rooms/session { currentPassword, newPassword } -> { account }   (change own password;
//        signs out every other session of the account)
// DELETE /api/rooms/session                                  -> { ok: true } and the cookie cleared
//
// Errors carry details.code: INVALID_CREDENTIALS, ACCOUNT_DISABLED, WEAK_PASSWORD,
// RATE_LIMITED, ROOMS_SIGNED_OUT.

import { HttpError, readJson, route, sendJson } from '../../server/http.js';
import { query } from '../../server/db.js';
import { clientIp, enforce, hashKey } from '../../server/rate-limit.js';
import {
  checkCredentials,
  clearSessionCookie,
  createSession,
  deleteSession,
  getRoomSession,
  hashPassword,
  hashToken,
  requireJsonRequest,
  requireRoomAccount,
  sessionToken,
  setSessionCookie,
  validatePassword,
  verifyPassword,
} from '../../server/rooms/auth.js';
import { normaliseUsername, selfDto } from '../../server/rooms/accounts.js';

const WINDOW_SECONDS = 15 * 60;
const PER_USERNAME_LIMIT = 10;
const PER_IP_LIMIT = 50;
const PER_USERNAME_GLOBAL_LIMIT = 30;
const PER_ACCOUNT_CHANGE_LIMIT = 10;

const INVALID = () => new HttpError(401, 'Incorrect username or password.', { code: 'INVALID_CREDENTIALS' });

export default route({
  GET: async (req, res) => {
    const account = await requireRoomAccount(req);
    sendJson(res, 200, { account: selfDto(account) });
  },

  POST: async (req, res) => {
    requireJsonRequest(req);
    const body = await readJson(req);
    const username = normaliseUsername(body.username);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) throw new HttpError(422, 'Enter your username and password.');
    if (username.length > 64 || password.length > 128) throw INVALID();

    const ip = clientIp(req);
    // Per IP+username, per IP, and per username from anywhere (a password
    // guesser spreading attempts over many IPs still hits the last one).
    await enforce(
      [
        { key: `rooms:login:u:${hashKey(`${ip}|${username}`)}`, limit: PER_USERNAME_LIMIT, windowSeconds: WINDOW_SECONDS },
        { key: `rooms:login:i:${hashKey(ip)}`, limit: PER_IP_LIMIT, windowSeconds: WINDOW_SECONDS },
        { key: `rooms:login:g:${hashKey(username)}`, limit: PER_USERNAME_GLOBAL_LIMIT, windowSeconds: WINDOW_SECONDS },
      ],
      'Too many sign-in attempts. Try again in a few minutes.',
    );

    const account = await checkCredentials(username, password);
    if (!account) throw INVALID();
    // Only said after a correct password, so it reveals nothing to a guesser.
    if (account.status !== 'active') {
      throw new HttpError(403, 'This Room Finder account has been disabled. Ask your admin.', { code: 'ACCOUNT_DISABLED' });
    }

    // Replace any session this browser already had.
    await deleteSession(sessionToken(req));
    const token = await createSession(account.id);
    await query('UPDATE room_finder_accounts SET last_login_at = now() WHERE id = $1', [account.id]);
    setSessionCookie(req, res, token);
    sendJson(res, 200, { account: selfDto(account) });
  },

  PATCH: async (req, res) => {
    requireJsonRequest(req);
    const session = await getRoomSession(req);
    if (!session) throw new HttpError(401, 'Sign in to the Room Finder', { code: 'ROOMS_SIGNED_OUT' });
    const { account, token } = session;

    const body = await readJson(req);
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = body.newPassword;

    await enforce(
      [{ key: `rooms:pwchange:${account.id}`, limit: PER_ACCOUNT_CHANGE_LIMIT, windowSeconds: WINDOW_SECONDS }],
      'Too many attempts. Try again in a few minutes.',
    );

    if (!(await verifyPassword(currentPassword, account.password_hash))) {
      throw new HttpError(403, 'Your current password is incorrect.', { code: 'INVALID_CREDENTIALS' });
    }
    validatePassword(newPassword);
    if (newPassword === currentPassword) {
      throw new HttpError(422, 'Choose a password different from your current one.', { code: 'WEAK_PASSWORD' });
    }

    await query(
      'UPDATE room_finder_accounts SET password_hash = $2, password_changed_at = now() WHERE id = $1',
      [account.id, await hashPassword(newPassword)],
    );
    await query('DELETE FROM room_finder_sessions WHERE account_id = $1 AND token_hash <> $2', [account.id, hashToken(token)]);
    sendJson(res, 200, { account: selfDto(account) });
  },

  DELETE: async (req, res) => {
    await deleteSession(sessionToken(req));
    clearSessionCookie(req, res);
    sendJson(res, 200, { ok: true });
  },
});
