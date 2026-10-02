// Free Room Finder accounts, managed by timetable-tool admins. One function for
// the collection and single accounts (`?id=`) to stay within Vercel's function cap.
//
// GET    /api/admin/room-accounts                               -> { accounts: [...] }
// POST   /api/admin/room-accounts { username, displayName?, password? }
//        -> 201 { account, temporaryPassword? }   (generated when no password is given;
//           shown only in this response)
// PATCH  /api/admin/room-accounts?id=<uuid> { status?, displayName?, resetPassword?, password? }
//        -> { account, temporaryPassword? }
//        status: 'active' | 'disabled'. resetPassword: true generates a new password
//        (returned once); `password` sets a given one. Either ends the account's
//        sessions, and so does disabling it.
// DELETE /api/admin/room-accounts?id=<uuid>                     -> { ok: true }

import { HttpError, param, readJson, route, sendJson } from '../../server/http.js';
import { requireAdmin } from '../../server/auth.js';
import { recordAudit } from '../../server/activity.js';
import { accountDto, createAccount, deleteAccount, listAccounts, updateAccount } from '../../server/rooms/accounts.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function accountId(req) {
  const id = String(param(req, 'id') ?? '');
  if (!UUID_RE.test(id)) throw new HttpError(404, 'Room Finder account not found');
  return id;
}

/** What changed, for the audit log. Never includes a password. */
function describeUpdate(body, account) {
  const bits = [];
  if (body.status !== undefined) bits.push(account.status === 'disabled' ? 'disabled' : 'enabled');
  if (body.resetPassword || (body.password !== undefined && body.password !== null)) bits.push('password reset');
  if (body.displayName !== undefined) bits.push('renamed');
  return `Room Finder account ${account.username}: ${bits.join(', ') || 'updated'}`;
}

export default route({
  GET: async (req, res) => {
    await requireAdmin(req);
    const rows = await listAccounts();
    sendJson(res, 200, { accounts: rows.map(accountDto) });
  },

  POST: async (req, res) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    const { account, temporaryPassword } = await createAccount({
      username: body.username,
      displayName: body.displayName,
      password: body.password,
      createdBy: admin.id,
    });
    await recordAudit(admin, 'room.create', { type: 'room', id: account.id }, `Created Room Finder account ${account.username}`);
    sendJson(res, 201, { account: accountDto(account), ...(temporaryPassword ? { temporaryPassword } : {}) });
  },

  PATCH: async (req, res) => {
    const admin = await requireAdmin(req);
    const id = accountId(req);
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(422, 'Expected a JSON object');
    const { account, temporaryPassword } = await updateAccount(id, {
      status: body.status,
      displayName: body.displayName,
      resetPassword: body.resetPassword,
      password: body.password,
    });
    await recordAudit(admin, 'room.update', { type: 'room', id: account.id }, describeUpdate(body, account), {
      status: body.status,
      displayName: body.displayName,
      passwordReset: Boolean(body.resetPassword || body.password),
    });
    sendJson(res, 200, { account: accountDto(account), ...(temporaryPassword ? { temporaryPassword } : {}) });
  },

  DELETE: async (req, res) => {
    const admin = await requireAdmin(req);
    const account = await deleteAccount(accountId(req));
    await recordAudit(admin, 'room.delete', { type: 'room', id: account.id }, `Deleted Room Finder account ${account.username}`);
    sendJson(res, 200, { ok: true });
  },
});
