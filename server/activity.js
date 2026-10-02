// Bookkeeping for the admin CMS: "last seen" / daily-active tracking and the
// audit log of admin writes (db/migrations/005_admin_cms.sql).
//
// Both fail soft: a broken insert is logged and swallowed, never turned into a
// failed request. A user must not lose a save because the audit table hiccuped.

import { query } from './db.js';

// The app's users are FAST-NUCES students; days are counted on Pakistan time.
export const APP_TIME_ZONE = 'Asia/Karachi';

const SEEN_EVERY_MS = 5 * 60 * 1000;

/**
 * Record that `user` (an app_users row) made a request. Cheap: does nothing
 * unless the row's last_seen_at is more than a few minutes old, so a busy user
 * costs one write per five minutes, not one per request.
 */
export async function touchLastSeen(user) {
  if (!user?.id) return;
  const last = user.last_seen_at ? new Date(user.last_seen_at).getTime() : 0;
  if (Date.now() - last < SEEN_EVERY_MS) return;
  try {
    await query(
      `WITH u AS (
         UPDATE app_users SET last_seen_at = now() WHERE id = $1 RETURNING id
       )
       INSERT INTO user_activity_days (user_id, day)
       SELECT id, (now() AT TIME ZONE '${APP_TIME_ZONE}')::date FROM u
       ON CONFLICT DO NOTHING`,
      [user.id],
    );
    user.last_seen_at = new Date();
  } catch (err) {
    console.error('touchLastSeen failed', err?.message || err);
  }
}

/**
 * Append an audit-log entry.
 *   actor   app_users row of whoever did it (id + email used)
 *   action  dotted verb, e.g. 'user.approve'
 *   target  { type, id }
 *   summary one human-readable line
 *   details any JSON (before/after values, file names, ...)
 */
export async function recordAudit(actor, action, { type = '', id = '' } = {}, summary = '', details = {}) {
  try {
    await query(
      `INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, summary, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        actor?.id ?? null,
        String(actor?.email ?? ''),
        action,
        type,
        String(id ?? ''),
        String(summary).slice(0, 500),
        JSON.stringify(details ?? {}),
      ],
    );
  } catch (err) {
    console.error('recordAudit failed', err?.message || err);
  }
}
