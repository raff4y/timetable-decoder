// Room Finder account management, shared by the admin API
// (api/admin/room-accounts*) and the CLI (scripts/room-accounts.mjs).
//
// When no password is given, a random one is generated and returned ONCE as
// `temporaryPassword`; only its hash is stored. The person can change it after
// signing in. Resetting a password or disabling an account ends its sessions.

import { query, tx } from '../db.js';
import { HttpError } from '../http.js';
import { generatePassword, hashPassword, validatePassword } from './auth.js';

const USERNAME_RE = /^[a-z0-9][a-z0-9._@+-]{2,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STATUSES = ['active', 'disabled'];

const iso = (d) => (d ? new Date(d).toISOString() : null);

export function accountDto(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    status: row.status,
    createdAt: iso(row.created_at),
    passwordChangedAt: iso(row.password_changed_at),
    lastLoginAt: iso(row.last_login_at),
  };
}

/** What the signed-in person sees about themselves. */
export function selfDto(row) {
  return { id: row.id, username: row.username, displayName: row.display_name };
}

export function normaliseUsername(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

export function validateUsername(username) {
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(
      422,
      'Usernames are 3-64 characters: letters, digits and . _ @ + - (an email address works).',
      { code: 'INVALID_USERNAME' },
    );
  }
}

function cleanName(raw) {
  return typeof raw === 'string' ? raw.trim().slice(0, 200) : '';
}

/** Resolve an id or username to the account row, or 404. */
export async function findAccount(idOrUsername) {
  const key = String(idOrUsername ?? '');
  const { rows } = UUID_RE.test(key)
    ? await query('SELECT * FROM room_finder_accounts WHERE id = $1', [key])
    : await query('SELECT * FROM room_finder_accounts WHERE username = $1', [normaliseUsername(key)]);
  if (!rows[0]) throw new HttpError(404, 'Room Finder account not found');
  return rows[0];
}

export async function listAccounts() {
  const { rows } = await query('SELECT * FROM room_finder_accounts ORDER BY username');
  return rows;
}

/** -> { account, temporaryPassword? } */
export async function createAccount({ username, displayName, password, createdBy = null }) {
  const name = normaliseUsername(username);
  validateUsername(name);
  const generated = password === undefined || password === null || password === '';
  const plain = generated ? generatePassword() : password;
  validatePassword(plain);

  const { rows } = await query(
    `INSERT INTO room_finder_accounts (username, display_name, password_hash, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (username) DO NOTHING RETURNING *`,
    [name, cleanName(displayName), await hashPassword(plain), createdBy],
  );
  if (!rows[0]) throw new HttpError(409, 'A Room Finder account with that username already exists.', { code: 'USERNAME_TAKEN' });
  return { account: rows[0], ...(generated ? { temporaryPassword: plain } : {}) };
}

/**
 * Apply any of { status, displayName, resetPassword, password } to an account.
 * `resetPassword: true` generates a password; `password` sets a given one.
 * -> { account, temporaryPassword? }
 */
export async function updateAccount(idOrUsername, changes = {}) {
  const target = await findAccount(idOrUsername);
  const { status, displayName, resetPassword, password } = changes;

  if (status !== undefined && !STATUSES.includes(status)) {
    throw new HttpError(422, `status must be one of ${STATUSES.join(', ')}`);
  }
  if (displayName !== undefined && typeof displayName !== 'string') {
    throw new HttpError(422, 'displayName must be a string');
  }
  if (resetPassword !== undefined && typeof resetPassword !== 'boolean') {
    throw new HttpError(422, 'resetPassword must be true or false');
  }
  const settingPassword = password !== undefined && password !== null;
  if (settingPassword) validatePassword(password);
  if (status === undefined && displayName === undefined && !resetPassword && !settingPassword) {
    throw new HttpError(422, 'Nothing to update');
  }

  const temporaryPassword = resetPassword && !settingPassword ? generatePassword() : undefined;
  const newPassword = settingPassword ? password : temporaryPassword;
  const newHash = newPassword ? await hashPassword(newPassword) : null;

  const row = await tx(async (client) => {
    const { rows } = await client.query(
      `UPDATE room_finder_accounts
          SET status = COALESCE($2, status),
              display_name = COALESCE($3, display_name),
              password_hash = COALESCE($4, password_hash),
              password_changed_at = CASE WHEN $4::text IS NULL THEN password_changed_at ELSE now() END
        WHERE id = $1 RETURNING *`,
      [target.id, status ?? null, displayName === undefined ? null : cleanName(displayName), newHash],
    );
    if (newHash || rows[0].status !== 'active') {
      await client.query('DELETE FROM room_finder_sessions WHERE account_id = $1', [target.id]);
    }
    return rows[0];
  });
  return { account: row, ...(temporaryPassword ? { temporaryPassword } : {}) };
}

export async function deleteAccount(idOrUsername) {
  const target = await findAccount(idOrUsername);
  await query('DELETE FROM room_finder_accounts WHERE id = $1', [target.id]);
  return target;
}
