// GET  /api/admin/users?status=pending  -> { users: [...] }
// POST /api/admin/users { email, displayName, role } -> 201 { user }  (pre-add)

import { HttpError, param, readJson, route, sendJson } from '../../server/http.js';
import { query } from '../../server/db.js';
import { requireAdmin, toAdminUser } from '../../server/auth.js';
import { recordAudit } from '../../server/activity.js';

const STATUSES = ['pending', 'approved', 'rejected', 'disabled'];
const ROLES = ['student', 'admin'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default route({
  GET: async (req, res) => {
    await requireAdmin(req);
    const status = param(req, 'status');
    if (status !== undefined && !STATUSES.includes(status)) {
      throw new HttpError(422, `status must be one of ${STATUSES.join(', ')}`);
    }
    const select = `SELECT u.*,
        (SELECT count(*) FROM saved_schedules s WHERE s.user_id = u.id)::int AS schedule_count
      FROM app_users u`;
    const { rows } = status
      ? await query(`${select} WHERE u.status = $1 ORDER BY u.created_at, u.email`, [status])
      : await query(`${select} ORDER BY u.created_at, u.email`);
    sendJson(res, 200, { users: rows.map(toAdminUser) });
  },

  POST: async (req, res) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(422, 'A valid email is required.');
    const role = body.role ?? 'student';
    if (!ROLES.includes(role)) throw new HttpError(422, `role must be one of ${ROLES.join(', ')}`);
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 200) : '';

    const { rows } = await query(
      `INSERT INTO app_users (email, display_name, role, status, source, approved_at, approved_by)
       VALUES ($1, $2, $3, 'approved', 'preadded', now(), $4)
       ON CONFLICT (email) DO NOTHING RETURNING *`,
      [email, displayName, role, admin.id],
    );
    if (!rows[0]) {
      throw new HttpError(409, 'An account with that email already exists. Use the user list to change it.');
    }
    await recordAudit(admin, 'user.preadd', { type: 'user', id: rows[0].id }, `Pre-added ${email} as ${role}`, {
      email,
      role,
      displayName,
    });
    sendJson(res, 201, { user: toAdminUser(rows[0]) });
  },
});
