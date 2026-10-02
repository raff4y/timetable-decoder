// PATCH /api/admin/users/:id { status?, role?, displayName?, revokeSessions? } -> { user }
//
// Revoking access: status 'disabled' (or any move away from 'approved') also
// signs the person out everywhere, at once: every token they hold is refused
// from the next request on, and their Neon Auth sessions are deleted.
// `revokeSessions: true` does only the sign-out (access kept; they must sign in
// again). See server/auth.js ("REVOKING ACCESS").
//
// Guards: the last approved admin cannot be demoted, rejected or disabled (by
// themselves or by anyone), so the app can never end up with no admins; and an
// admin cannot revoke their own access (another admin has to).

import { HttpError, param, readJson, route, sendJson } from '../../../server/http.js';
import { tx } from '../../../server/db.js';
import { endNeonSessions, requireAdmin, toAdminUser } from '../../../server/auth.js';
import { recordAudit } from '../../../server/activity.js';

const STATUSES = ['pending', 'approved', 'rejected', 'disabled'];
const ROLES = ['student', 'admin'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default route({
  PATCH: async (req, res) => {
    const admin = await requireAdmin(req);
    const id = String(param(req, 'id') ?? '');
    if (!UUID_RE.test(id)) throw new HttpError(404, 'User not found');

    const body = await readJson(req);
    const hasStatus = body.status !== undefined;
    const hasRole = body.role !== undefined;
    const hasName = body.displayName !== undefined;
    const hasRevoke = body.revokeSessions !== undefined;
    if (!hasStatus && !hasRole && !hasName && !hasRevoke) {
      throw new HttpError(422, 'Provide status, role, displayName and/or revokeSessions.');
    }
    if (hasRevoke && typeof body.revokeSessions !== 'boolean') throw new HttpError(422, 'revokeSessions must be true or false');
    if (hasStatus && !STATUSES.includes(body.status)) throw new HttpError(422, `status must be one of ${STATUSES.join(', ')}`);
    if (hasRole && !ROLES.includes(body.role)) throw new HttpError(422, `role must be one of ${ROLES.join(', ')}`);
    if (hasName && typeof body.displayName !== 'string') throw new HttpError(422, 'displayName must be a string');
    const nextName = hasName ? body.displayName.trim().slice(0, 200) : null;

    let before;
    let revoking = false;

    const updated = await tx(async (client) => {
      // Lock every approved admin row so concurrent demotions serialise.
      const admins = await client.query(
        `SELECT id FROM app_users WHERE role = 'admin' AND status = 'approved' ORDER BY id FOR UPDATE`,
      );
      const target = (await client.query('SELECT * FROM app_users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!target) throw new HttpError(404, 'User not found');
      before = target;

      const nextStatus = hasStatus ? body.status : target.status;
      const nextRole = hasRole ? body.role : target.role;

      const wasApprovedAdmin = target.role === 'admin' && target.status === 'approved';
      const staysApprovedAdmin = nextRole === 'admin' && nextStatus === 'approved';
      if (wasApprovedAdmin && !staysApprovedAdmin && !admins.rows.some((a) => a.id !== target.id)) {
        throw new HttpError(
          409,
          target.id === admin.id
            ? 'You are the only admin; make someone else an admin first.'
            : 'That is the only admin; make someone else an admin first.',
          { code: 'LAST_ADMIN' },
        );
      }

      if (target.id === admin.id && nextStatus !== target.status && nextStatus !== 'approved') {
        throw new HttpError(409, 'You cannot revoke your own access; another admin has to.', { code: 'SELF_LOCKOUT' });
      }

      const becomingApproved = nextStatus === 'approved' && target.status !== 'approved';
      revoking =
        body.revokeSessions === true ||
        nextStatus === 'disabled' ||
        (target.status === 'approved' && nextStatus !== 'approved');
      const { rows } = await client.query(
        `UPDATE app_users
            SET status = $2, role = $3,
                approved_at = CASE WHEN $4::boolean THEN now() ELSE approved_at END,
                approved_by = CASE WHEN $4::boolean THEN $5::uuid ELSE approved_by END,
                display_name = COALESCE($6, display_name),
                sessions_revoked_at = CASE WHEN $7::boolean THEN now() ELSE sessions_revoked_at END
          WHERE id = $1 RETURNING *`,
        [id, nextStatus, nextRole, becomingApproved, admin.id, nextName, revoking],
      );
      return rows[0];
    });

    // After the commit, so the revocation stands even if this part fails.
    if (revoking) await endNeonSessions(updated.auth_user_id);
    if (revoking && body.revokeSessions === true && before.status === updated.status) {
      await recordAudit(admin, 'user.signout', { type: 'user', id: updated.id }, `Signed ${updated.email} out everywhere`, {});
    }

    await auditUserChange(admin, before, updated);
    sendJson(res, 200, { user: toAdminUser(updated) });
  },
});

const STATUS_VERB = { approved: 'approve', rejected: 'reject', disabled: 'disable', pending: 'reset' };

async function auditUserChange(admin, before, after) {
  const changes = {};
  for (const [field, column] of [['status', 'status'], ['role', 'role'], ['displayName', 'display_name']]) {
    if (before[column] !== after[column]) changes[field] = { from: before[column], to: after[column] };
  }
  if (!Object.keys(changes).length) return;
  const target = { type: 'user', id: after.id };
  const who = after.email;
  if (changes.status) {
    const verb = STATUS_VERB[after.status] || 'update';
    const text = {
      approve: before.status === 'disabled' ? `Re-enabled ${who}` : `Approved ${who}`,
      reject: `Rejected ${who}`,
      disable: `Revoked access for ${who} and signed them out`,
      reset: `Moved ${who} back to pending`,
      update: `Updated ${who}`,
    }[verb];
    await recordAudit(admin, `user.${verb}`, target, text, changes);
  }
  if (changes.role) {
    await recordAudit(admin, 'user.role', target, `Changed ${who} from ${before.role} to ${after.role}`, changes);
  }
  if (changes.displayName && !changes.status && !changes.role) {
    await recordAudit(admin, 'user.rename', target, `Renamed ${who} to "${after.display_name}"`, changes);
  }
}
