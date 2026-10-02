// Admin CMS: /api/admin/{stats,insights,activity,timetables,timetable}, the
// audit log written by admin writes, and last-seen / daily-active tracking.
// In-memory Postgres (PGlite); auth faked through the create*Handler seams.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setDbDriver, query } from '../server/db.js';
import { HttpError, route } from '../server/http.js';
import { createTimetableHandlers } from '../api/timetables/_lib.js';
import { createScheduleHandlers } from '../api/schedules/_lib.js';
import { createCmsHandler } from '../api/admin/_cms.js';
import { touchLastSeen, recordAudit } from '../server/activity.js';
import { createTestDb } from './helpers/pglite-db.js';
import { flatWorkbook } from './fixtures/build-workbooks.js';

let db;
const users = {};

const auth = {
  async requireApprovedUser(req) {
    if (!req.user) throw new HttpError(401, 'Not signed in');
    if (req.user.status !== 'approved') throw new HttpError(403, 'Account not approved');
    return req.user;
  },
  async requireAdmin(req) {
    const user = await auth.requireApprovedUser(req);
    if (user.role !== 'admin') throw new HttpError(403, 'Admins only');
    return user;
  },
};

const tt = createTimetableHandlers(auth);
const sched = createScheduleHandlers(auth);
const listHandler = route({ GET: tt.index.GET, POST: tt.index.POST });
const itemHandler = route({ GET: tt.item.GET, PATCH: tt.item.PATCH, DELETE: tt.item.DELETE });
const scheduleHandler = route({ GET: sched.GET, PUT: sched.PUT });
const cmsHandler = route({ GET: createCmsHandler(auth) });

async function call(handler, { method = 'GET', user, query: q = {}, json, raw, headers = {} } = {}) {
  const req = { method, url: '/api/test', query: q, headers: { ...headers }, user };
  if (json !== undefined) req.rawBody = Buffer.from(JSON.stringify(json));
  if (raw !== undefined) req.rawBody = raw;
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(body) { this.body = body; },
  };
  await handler(req, res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
}

const screen = (name, user, q = {}) => call(cmsHandler, { user, query: { screen: name, ...q } });

let timetable;

before(async () => {
  db = await createTestDb();
  setDbDriver(db);
  const add = async (email, role, status, extra = '') => {
    const { rows } = await query(
      `INSERT INTO app_users (email, role, status, display_name) VALUES ($1, $2, $3, $4) RETURNING *`,
      [email, role, status, extra],
    );
    return rows[0];
  };
  users.admin = await add('admin@example.com', 'admin', 'approved', 'Ada Admin');
  users.s1 = await add('s1@example.com', 'student', 'approved');
  users.s2 = await add('s2@example.com', 'student', 'approved');
  users.s3 = await add('s3@example.com', 'student', 'approved');
  users.pending = await add('pending@example.com', 'student', 'pending');

  const up = await call(listHandler, {
    method: 'POST',
    user: users.admin,
    raw: flatWorkbook(),
    headers: { 'content-type': 'application/octet-stream', 'x-filename': 'CS.xlsx' },
  });
  assert.equal(up.status, 201);
  timetable = up.json.timetable;
  const pub = await call(itemHandler, {
    method: 'PATCH', user: users.admin, query: { id: timetable.id }, json: { isPublished: true },
  });
  assert.equal(pub.status, 200);

  const save = (user, keys) =>
    call(scheduleHandler, { method: 'PUT', user, query: { timetableId: timetable.id }, json: { sectionKeys: keys } });
  assert.equal((await save(users.s1, ['CS1002|A', 'CL1002|A1', 'MT1003|B'])).status, 200);
  assert.equal((await save(users.s2, ['CS1002|A', 'CL1002|A1'])).status, 200);
  assert.equal((await save(users.s3, [])).status, 200); // empty schedules are not counted
});

after(async () => {
  setDbDriver(null);
  await db.end();
});

test('every CMS screen is admin only, and unknown screens 404', async () => {
  for (const name of ['stats', 'insights', 'activity', 'timetables']) {
    assert.equal((await screen(name, null)).status, 401, name);
    assert.equal((await screen(name, users.s1)).status, 403, name);
    assert.equal((await screen(name, users.pending)).status, 403, name);
  }
  assert.equal((await screen('nope', users.admin)).status, 404);
  assert.equal((await screen('constructor', users.admin)).status, 404);
  assert.equal((await call(cmsHandler, { method: 'POST', user: users.admin, query: { screen: 'stats' } })).status, 405);
});

test('touchLastSeen records last_seen_at and one activity row per day, throttled', async () => {
  const row = (await query('SELECT * FROM app_users WHERE id = $1', [users.s1.id])).rows[0];
  await touchLastSeen(row);
  await touchLastSeen(row); // throttled: no second write
  const seen = (await query('SELECT last_seen_at FROM app_users WHERE id = $1', [users.s1.id])).rows[0];
  assert.ok(seen.last_seen_at);
  const days = await query('SELECT * FROM user_activity_days WHERE user_id = $1', [users.s1.id]);
  assert.equal(days.rows.length, 1);

  // A stale row writes again but still keeps one row for today.
  await touchLastSeen({ id: users.s1.id, last_seen_at: new Date(Date.now() - 3_600_000) });
  assert.equal((await query('SELECT * FROM user_activity_days WHERE user_id = $1', [users.s1.id])).rows.length, 1);

  // Never throws, even for a user id that does not exist.
  await touchLastSeen({ id: '00000000-0000-4000-8000-000000000000' });
});

test('stats: KPIs, 30-day trend, top timetables, queues', async () => {
  await touchLastSeen({ id: users.s2.id });
  const res = await screen('stats', users.admin);
  assert.equal(res.status, 200);
  const s = res.json;
  assert.equal(s.users.total, 5);
  assert.equal(s.users.pending, 1);
  assert.equal(s.users.approved, 4);
  assert.equal(s.users.admins, 1);
  assert.equal(s.users.newThisWeek, 5);
  assert.equal(s.active.today, 2);
  assert.equal(s.active.week, 2);
  assert.deepEqual(s.timetables, { total: 1, published: 1, sections: 3, meetings: 5 });
  assert.equal(s.schedules.total, 2);
  assert.equal(s.schedules.avgSections, 2.5);

  assert.equal(s.trend.length, 30);
  const today = s.trend.at(-1);
  assert.equal(today.signups, 5);
  assert.equal(today.active, 2);
  assert.ok(s.trend.every((d, i) => i === 0 || d.day > s.trend[i - 1].day), 'days ascend');

  assert.equal(s.topTimetables[0].id, timetable.id);
  assert.equal(s.topTimetables[0].schedules, 2);
  assert.deepEqual(s.pendingUsers.map((u) => u.email), ['pending@example.com']);
  assert.ok(s.recentActivity.some((a) => a.action === 'timetable.upload'));
  // C-101, Lab 2, C-205 across the published timetable; no Room Finder accounts yet.
  assert.deepEqual(s.roomFinder, { accounts: 0, activeAccounts: 0, signedInThisWeek: 0, rooms: 3 });
});

test('insights: course, section and teacher demand for a timetable', async () => {
  const res = await screen('insights', users.admin);
  assert.equal(res.status, 200);
  const d = res.json;
  assert.equal(d.timetable.id, timetable.id, 'defaults to the newest published timetable');
  assert.deepEqual(d.summary, {
    schedules: 2,
    avgSections: 2.5,
    sectionsTotal: 3,
    sectionsPicked: 3,
    coursesTotal: 3,
    coursesPicked: 3,
    teachersTotal: 3,
  });
  assert.deepEqual(d.topCourses.slice(0, 2).map((c) => [c.code, c.students]), [['CL1002', 2], ['CS1002', 2]]);
  assert.equal(d.topSections.find((s) => s.code === 'MT1003').students, 1);
  assert.equal(d.topTeachers[0].students, 2);
  // CS1002 A meets Mon + Wed, CL1002 Tue, MT1003 Thu + Sat; s1 has all, s2 the first two.
  assert.deepEqual(d.dayLoad, [
    { dayIdx: 0, meetings: 2 },
    { dayIdx: 1, meetings: 2 },
    { dayIdx: 2, meetings: 2 },
    { dayIdx: 3, meetings: 1 },
    { dayIdx: 5, meetings: 1 },
  ]);
  assert.deepEqual(d.scheduleSizes, [{ size: 2, schedules: 1 }, { size: 3, schedules: 1 }]);
  assert.deepEqual(d.unpickedCourses, []);

  assert.equal((await screen('insights', users.admin, { timetableId: 'bad' })).status, 404);
  assert.equal(
    (await screen('insights', users.admin, { timetableId: '00000000-0000-4000-8000-000000000000' })).status,
    404,
  );
});

test('timetables + timetable detail carry usage counts', async () => {
  const list = await screen('timetables', users.admin);
  assert.equal(list.status, 200);
  const t = list.json.timetables[0];
  assert.equal(t.schedules, 2);
  assert.equal(t.meetings, 5);
  assert.ok(t.warningCount >= 1);
  assert.equal(t.uploader.email, 'admin@example.com');

  const one = await screen('timetable', users.admin, { id: timetable.id });
  assert.equal(one.status, 200);
  assert.equal(one.json.stats.sections, 3);
  assert.equal(one.json.stats.schedules, 2);
  assert.equal(one.json.stats.labMeetings, 1);
  assert.equal(one.json.sections.find((s) => s.key === 'CS1002|A').picks, 2);
  assert.equal(one.json.sections.find((s) => s.key === 'MT1003|B').picks, 1);
  assert.ok(Array.isArray(one.json.timetable.warnings));
  assert.equal((await screen('timetable', users.admin, { id: 'x' })).status, 404);
});

test('admin writes land in the audit log; activity searches, filters and pages', async () => {
  await call(itemHandler, {
    method: 'PATCH', user: users.admin, query: { id: timetable.id }, json: { title: 'CS Fall 2026', semester: 'Fall 2026' },
  });
  await recordAudit(users.admin, 'user.approve', { type: 'user', id: users.s1.id }, 'Approved s1@example.com');

  const all = await screen('activity', users.admin);
  assert.equal(all.status, 200);
  const actions = all.json.entries.map((e) => e.action);
  assert.deepEqual(actions, ['user.approve', 'timetable.edit', 'timetable.publish', 'timetable.upload']);
  assert.equal(all.json.entries[0].actorName, 'Ada Admin');
  assert.equal(all.json.total, 4);
  assert.ok(all.json.actions.some((a) => a.action === 'timetable.upload' && a.count === 1));
  const edit = all.json.entries.find((e) => e.action === 'timetable.edit');
  assert.deepEqual(edit.details.title.to, 'CS Fall 2026');

  const byGroup = await screen('activity', users.admin, { action: 'timetable' });
  assert.equal(byGroup.json.total, 3);
  const exact = await screen('activity', users.admin, { action: 'timetable.publish' });
  assert.equal(exact.json.total, 1);
  const search = await screen('activity', users.admin, { q: 's1@' });
  assert.deepEqual(search.json.entries.map((e) => e.action), ['user.approve']);
  const wild = await screen('activity', users.admin, { q: '%' });
  assert.equal(wild.json.total, 0, 'LIKE wildcards in the search are literal');
  const page2 = await screen('activity', users.admin, { page: '2' });
  assert.equal(page2.json.entries.length, 0);
  assert.equal(page2.json.page, 2);
});

test('deleting a timetable is audited', async () => {
  const del = await call(itemHandler, { method: 'DELETE', user: users.admin, query: { id: timetable.id } });
  assert.equal(del.status, 200);
  const log = await screen('activity', users.admin, { action: 'timetable.delete' });
  assert.equal(log.json.total, 1);
  assert.match(log.json.entries[0].summary, /CS Fall 2026/);

  const empty = await screen('insights', users.admin);
  assert.deepEqual(empty.json, { timetables: [], timetable: null });
});
