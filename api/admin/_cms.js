// Read endpoints behind the admin CMS (cms.html), one per screen:
//
//   GET /api/admin/stats                      dashboard: KPIs, 30-day trends, queues
//   GET /api/admin/insights?timetableId=      course demand for one timetable
//   GET /api/admin/activity?q=&action=&page=  audit log, searchable + paged
//   GET /api/admin/timetables                 timetable library with usage counts
//   GET /api/admin/timetable?id=              one timetable: sections + picks
//
// All admin-only. Writes still go through the existing endpoints
// (/api/admin/users*, /api/timetables*), which record the audit log.
// Like api/timetables/_lib.js, auth is injected so tests can fake it.

import { query } from '../../server/db.js';
import { HttpError, param, sendJson } from '../../server/http.js';
import { toAdminUser } from '../../server/auth.js';
import { APP_TIME_ZONE } from '../../server/activity.js';
import { isUuid, loadSections, timetableDto } from '../timetables/_lib.js';

export const TREND_DAYS = 30;
export const ACTIVITY_PAGE_SIZE = 50;

const TODAY = `(now() AT TIME ZONE '${APP_TIME_ZONE}')::date`;
const iso = (d) => (d ? new Date(d).toISOString() : null);

function auditDto(r) {
  return {
    id: String(r.id),
    actorId: r.actor_id,
    actorEmail: r.actor_email,
    actorName: r.actor_name || '',
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    summary: r.summary,
    details: r.details,
    createdAt: iso(r.created_at),
  };
}

const AUDIT_SELECT = `SELECT a.*, u.display_name AS actor_name
  FROM audit_log a LEFT JOIN app_users u ON u.id = a.actor_id`;

// ---------------------------------------------------------------- dashboard

// Free Room Finder figures. Its tables belong to another feature
// (db/migrations/004_room_finder.sql), so a failure here degrades to null
// instead of blanking the whole dashboard.
async function roomFinderStats() {
  try {
    const [accounts, rooms] = await Promise.all([
      query(`
        SELECT count(*)::int AS total,
          count(*) FILTER (WHERE status = 'active')::int AS active,
          count(*) FILTER (WHERE last_login_at >= now() - interval '7 days')::int AS week
        FROM room_finder_accounts`),
      query(`
        SELECT count(DISTINCT m.room)::int AS n
        FROM meetings m
        JOIN sections s ON s.id = m.section_id
        JOIN timetables t ON t.id = s.timetable_id
        WHERE t.is_published AND m.room <> ''`),
    ]);
    const a = accounts.rows[0];
    return { accounts: a.total, activeAccounts: a.active, signedInThisWeek: a.week, rooms: rooms.rows[0].n };
  } catch (err) {
    console.error('roomFinderStats failed', err?.message || err);
    return null;
  }
}

async function stats() {
  const [users, active, library, schedules, trend, topTimetables, recent, pending, roomFinder] = await Promise.all([
    query(`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status = 'pending')::int  AS pending,
        count(*) FILTER (WHERE status = 'approved')::int AS approved,
        count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
        count(*) FILTER (WHERE status = 'disabled')::int AS disabled,
        count(*) FILTER (WHERE role = 'admin' AND status = 'approved')::int AS admins,
        count(*) FILTER (WHERE source = 'preadded' AND auth_user_id IS NULL)::int AS unclaimed,
        count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS new7,
        count(*) FILTER (WHERE created_at >= now() - interval '14 days'
                           AND created_at <  now() - interval '7 days')::int AS new_prev7
      FROM app_users`),
    query(`
      SELECT count(DISTINCT user_id) FILTER (WHERE day = ${TODAY})::int AS today,
        count(DISTINCT user_id) FILTER (WHERE day > ${TODAY} - 7)::int AS week,
        count(DISTINCT user_id) FILTER (WHERE day > ${TODAY} - 14 AND day <= ${TODAY} - 7)::int AS prev_week,
        count(DISTINCT user_id)::int AS month
      FROM user_activity_days WHERE day > ${TODAY} - 30`),
    query(`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE is_published)::int AS published,
        COALESCE(sum(section_count), 0)::int AS sections,
        (SELECT count(*) FROM meetings)::int AS meetings
      FROM timetables`),
    query(`
      SELECT count(*)::int AS total,
        count(DISTINCT user_id)::int AS users,
        COALESCE(avg(cardinality(section_keys)), 0)::float AS avg_size,
        count(*) FILTER (WHERE updated_at >= now() - interval '7 days')::int AS week
      FROM saved_schedules WHERE cardinality(section_keys) > 0`),
    query(`
      WITH days AS (
        SELECT (${TODAY} - g)::date AS day FROM generate_series(0, ${TREND_DAYS - 1}) AS g
      ), su AS (
        SELECT (created_at AT TIME ZONE '${APP_TIME_ZONE}')::date AS day, count(*) AS n
        FROM app_users WHERE created_at >= now() - interval '${TREND_DAYS + 1} days' GROUP BY 1
      ), ac AS (
        SELECT day, count(*) AS n FROM user_activity_days
        WHERE day > ${TODAY} - ${TREND_DAYS} GROUP BY 1
      )
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
        COALESCE(su.n, 0)::int AS signups, COALESCE(ac.n, 0)::int AS active
      FROM days d LEFT JOIN su ON su.day = d.day LEFT JOIN ac ON ac.day = d.day
      ORDER BY d.day`),
    query(`
      SELECT t.id, t.title, t.department, t.semester, t.is_published, t.section_count,
        count(s.user_id)::int AS schedules
      FROM timetables t
      LEFT JOIN saved_schedules s ON s.timetable_id = t.id AND cardinality(s.section_keys) > 0
      GROUP BY t.id
      ORDER BY schedules DESC, t.created_at DESC
      LIMIT 6`),
    query(`${AUDIT_SELECT} ORDER BY a.created_at DESC, a.id DESC LIMIT 8`),
    query(`SELECT * FROM app_users WHERE status = 'pending' ORDER BY created_at LIMIT 6`),
    roomFinderStats(),
  ]);

  const u = users.rows[0];
  const a = active.rows[0];
  const l = library.rows[0];
  const s = schedules.rows[0];
  return {
    users: {
      total: u.total,
      pending: u.pending,
      approved: u.approved,
      rejected: u.rejected,
      disabled: u.disabled,
      admins: u.admins,
      unclaimedInvites: u.unclaimed,
      newThisWeek: u.new7,
      newLastWeek: u.new_prev7,
    },
    active: { today: a.today, week: a.week, lastWeek: a.prev_week, month: a.month },
    timetables: { total: l.total, published: l.published, sections: l.sections, meetings: l.meetings },
    schedules: { total: s.total, users: s.users, avgSections: Number(s.avg_size) || 0, savedThisWeek: s.week },
    trend: trend.rows.map((r) => ({ day: r.day, signups: r.signups, active: r.active })),
    topTimetables: topTimetables.rows.map((r) => ({
      id: r.id,
      title: r.title,
      department: r.department,
      semester: r.semester,
      isPublished: r.is_published,
      sectionCount: r.section_count,
      schedules: r.schedules,
    })),
    recentActivity: recent.rows.map(auditDto),
    pendingUsers: pending.rows.map(toAdminUser),
    roomFinder,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- course demand

// Each saved pick resolved to its section row. $1 = timetable id.
const PICKS = `
  picks AS (
    SELECT ss.user_id, k.key
    FROM saved_schedules ss CROSS JOIN LATERAL unnest(ss.section_keys) AS k(key)
    WHERE ss.timetable_id = $1
  ),
  ps AS (
    SELECT p.user_id, s.id AS section_id, s.code, s.name, s.section, s.teacher
    FROM picks p
    JOIN sections s ON s.timetable_id = $1 AND s.code || '|' || s.section = p.key
  )`;

async function listTimetablesBrief() {
  const { rows } = await query(
    `SELECT id, title, department, semester, is_published, created_at
     FROM timetables ORDER BY is_published DESC, created_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    department: r.department,
    semester: r.semester,
    isPublished: r.is_published,
    uploadedAt: iso(r.created_at),
  }));
}

async function insights(req) {
  const timetables = await listTimetablesBrief();
  const requested = param(req, 'timetableId');
  if (requested && !isUuid(requested)) throw new HttpError(404, 'Timetable not found');
  const selected = requested ? timetables.find((t) => t.id === requested) : timetables[0];
  if (requested && !selected) throw new HttpError(404, 'Timetable not found');
  if (!selected) return { timetables, timetable: null };

  const id = selected.id;
  const [summary, courses, sections, teachers, days, sizes, unpicked] = await Promise.all([
    query(
      `WITH ${PICKS}
       SELECT
         (SELECT count(*) FROM saved_schedules WHERE timetable_id = $1 AND cardinality(section_keys) > 0)::int AS schedules,
         (SELECT COALESCE(avg(cardinality(section_keys)), 0) FROM saved_schedules
           WHERE timetable_id = $1 AND cardinality(section_keys) > 0)::float AS avg_size,
         (SELECT count(*) FROM sections WHERE timetable_id = $1)::int AS sections_total,
         (SELECT count(DISTINCT section_id) FROM ps)::int AS sections_picked,
         (SELECT count(DISTINCT code) FROM sections WHERE timetable_id = $1)::int AS courses_total,
         (SELECT count(DISTINCT code) FROM ps)::int AS courses_picked,
         (SELECT count(DISTINCT teacher) FROM sections WHERE timetable_id = $1 AND teacher <> '')::int AS teachers_total`,
      [id],
    ),
    query(
      `WITH ${PICKS}
       SELECT code, max(name) AS name, count(DISTINCT user_id)::int AS students,
         count(DISTINCT section_id)::int AS sections
       FROM ps GROUP BY code ORDER BY students DESC, code LIMIT 20`,
      [id],
    ),
    query(
      `WITH ${PICKS}
       SELECT code, max(name) AS name, section, max(teacher) AS teacher,
         count(DISTINCT user_id)::int AS students
       FROM ps GROUP BY code, section ORDER BY students DESC, code, section LIMIT 20`,
      [id],
    ),
    query(
      `WITH ${PICKS}
       SELECT teacher, count(DISTINCT user_id)::int AS students,
         count(DISTINCT section_id)::int AS sections
       FROM ps WHERE teacher <> '' GROUP BY teacher ORDER BY students DESC, teacher LIMIT 15`,
      [id],
    ),
    query(
      `WITH ${PICKS}
       SELECT m.day_idx, count(*)::int AS meetings
       FROM ps JOIN meetings m ON m.section_id = ps.section_id
       GROUP BY m.day_idx ORDER BY m.day_idx`,
      [id],
    ),
    query(
      `SELECT cardinality(section_keys) AS size, count(*)::int AS schedules
       FROM saved_schedules WHERE timetable_id = $1 AND cardinality(section_keys) > 0
       GROUP BY 1 ORDER BY 1`,
      [id],
    ),
    query(
      `WITH ${PICKS}
       SELECT s.code, max(s.name) AS name, count(*)::int AS sections
       FROM sections s
       WHERE s.timetable_id = $1 AND s.code NOT IN (SELECT code FROM ps)
       GROUP BY s.code ORDER BY s.code LIMIT 50`,
      [id],
    ),
  ]);

  const sm = summary.rows[0];
  return {
    timetables,
    timetable: selected,
    summary: {
      schedules: sm.schedules,
      avgSections: Number(sm.avg_size) || 0,
      sectionsTotal: sm.sections_total,
      sectionsPicked: sm.sections_picked,
      coursesTotal: sm.courses_total,
      coursesPicked: sm.courses_picked,
      teachersTotal: sm.teachers_total,
    },
    topCourses: courses.rows,
    topSections: sections.rows,
    topTeachers: teachers.rows,
    dayLoad: days.rows.map((r) => ({ dayIdx: r.day_idx, meetings: r.meetings })),
    scheduleSizes: sizes.rows.map((r) => ({ size: Number(r.size), schedules: r.schedules })),
    unpickedCourses: unpicked.rows,
  };
}

// ---------------------------------------------------------------- activity

async function activity(req) {
  const q = String(param(req, 'q') ?? '').trim().slice(0, 100);
  const action = String(param(req, 'action') ?? '').trim().slice(0, 60);
  const page = Math.max(1, Math.min(10_000, Number.parseInt(param(req, 'page') ?? '1', 10) || 1));

  const where = [];
  const values = [];
  if (q) {
    values.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const p = `$${values.length}`;
    where.push(`(a.summary ILIKE ${p} OR a.actor_email ILIKE ${p} OR COALESCE(u.display_name, '') ILIKE ${p})`);
  }
  if (action) {
    // 'user' matches every user.* action; 'user.approve' matches exactly.
    values.push(action.includes('.') ? action : `${action}.%`);
    where.push(action.includes('.') ? `a.action = $${values.length}` : `a.action LIKE $${values.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [count, rows, actions] = await Promise.all([
    query(`SELECT count(*)::int AS n FROM audit_log a LEFT JOIN app_users u ON u.id = a.actor_id ${whereSql}`, values),
    query(
      `${AUDIT_SELECT} ${whereSql} ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${ACTIVITY_PAGE_SIZE} OFFSET ${(page - 1) * ACTIVITY_PAGE_SIZE}`,
      values,
    ),
    query(`SELECT action, count(*)::int AS n FROM audit_log GROUP BY action ORDER BY action`),
  ]);

  return {
    entries: rows.rows.map(auditDto),
    total: count.rows[0].n,
    page,
    pageSize: ACTIVITY_PAGE_SIZE,
    actions: actions.rows.map((r) => ({ action: r.action, count: r.n })),
  };
}

// ---------------------------------------------------------------- timetable library

async function timetables() {
  const { rows } = await query(`
    SELECT t.id, t.department, t.semester, t.title, t.template, t.section_count, t.is_published,
      t.explicit_durations, t.file_name, t.file_size, t.created_at, t.updated_at,
      jsonb_array_length(t.warnings)::int AS warning_count,
      u.email AS uploader_email, u.display_name AS uploader_name,
      (SELECT count(*) FROM saved_schedules s
        WHERE s.timetable_id = t.id AND cardinality(s.section_keys) > 0)::int AS schedules,
      (SELECT count(*) FROM meetings m JOIN sections se ON se.id = m.section_id
        WHERE se.timetable_id = t.id)::int AS meetings
    FROM timetables t LEFT JOIN app_users u ON u.id = t.uploaded_by
    ORDER BY t.created_at DESC`);
  return {
    timetables: rows.map((r) =>
      timetableDto(r, {
        fileSize: r.file_size,
        updatedAt: iso(r.updated_at),
        warningCount: r.warning_count,
        uploader: r.uploader_email ? { email: r.uploader_email, displayName: r.uploader_name } : null,
        schedules: r.schedules,
        meetings: r.meetings,
      }),
    ),
  };
}

async function timetable(req) {
  const id = param(req, 'id');
  if (!isUuid(id)) throw new HttpError(404, 'Timetable not found');
  const { rows } = await query(
    `SELECT t.id, t.department, t.semester, t.title, t.template, t.section_count, t.is_published,
       t.explicit_durations, t.file_name, t.file_size, t.warnings, t.created_at, t.updated_at,
       u.email AS uploader_email, u.display_name AS uploader_name
     FROM timetables t LEFT JOIN app_users u ON u.id = t.uploaded_by
     WHERE t.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Timetable not found');

  const [sections, picks, schedules] = await Promise.all([
    loadSections(id),
    query(
      `SELECT k.key, count(DISTINCT ss.user_id)::int AS n
       FROM saved_schedules ss CROSS JOIN LATERAL unnest(ss.section_keys) AS k(key)
       WHERE ss.timetable_id = $1 GROUP BY k.key`,
      [id],
    ),
    query(
      `SELECT count(*)::int AS n FROM saved_schedules WHERE timetable_id = $1 AND cardinality(section_keys) > 0`,
      [id],
    ),
  ]);
  const pickByKey = new Map(picks.rows.map((r) => [r.key, r.n]));

  const codes = new Set();
  const teachers = new Set();
  const rooms = new Set();
  let meetings = 0;
  let labMeetings = 0;
  const withPicks = sections.map((s) => {
    codes.add(s.code);
    if (s.teacher) teachers.add(s.teacher);
    for (const m of s.meetings) {
      meetings++;
      if (m.isLab) labMeetings++;
      if (m.room) rooms.add(m.room);
    }
    return { ...s, key: `${s.code}|${s.section}`, picks: pickByKey.get(`${s.code}|${s.section}`) || 0 };
  });

  return {
    timetable: timetableDto(row, {
      fileSize: row.file_size,
      updatedAt: iso(row.updated_at),
      warnings: row.warnings,
      uploader: row.uploader_email ? { email: row.uploader_email, displayName: row.uploader_name } : null,
    }),
    stats: {
      sections: sections.length,
      courses: codes.size,
      teachers: teachers.size,
      rooms: rooms.size,
      meetings,
      labMeetings,
      schedules: schedules.rows[0].n,
    },
    sections: withPicks,
  };
}

// ---------------------------------------------------------------- wiring

export const SCREENS = { stats, insights, activity, timetables, timetable };

/** @param {{ requireAdmin: Function }} auth */
export function createCmsHandler({ requireAdmin }) {
  return async function GET(req, res) {
    await requireAdmin(req);
    const screen = String(param(req, 'screen') ?? '');
    const fn = Object.hasOwn(SCREENS, screen) ? SCREENS[screen] : null;
    if (!fn) throw new HttpError(404, 'Not found');
    sendJson(res, 200, await fn(req));
  };
}
