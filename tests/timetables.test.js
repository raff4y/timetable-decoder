// /api/timetables and /api/schedules against in-memory Postgres (PGlite), with
// auth faked through the createXHandlers() seam (no module mocking needed).

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDbDriver, query } from '../server/db.js';
import { HttpError, route } from '../server/http.js';
import { createTimetableHandlers } from '../api/timetables/_lib.js';
import { createScheduleHandlers } from '../api/schedules/_lib.js';
import { createTestDb } from './helpers/pglite-db.js';
import { flatWorkbook, gridWorkbook, unrelatedWorkbook } from './fixtures/build-workbooks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let db;
const users = {};

// Auth seam: the test sets `req.user` (null = signed out).
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

/** Invoke a handler with a fake req/res; resolves { status, json }. */
async function call(handler, { method = 'GET', user, query: q = {}, json, raw, headers = {} } = {}) {
  const req = {
    method,
    url: '/api/test',
    query: q,
    headers: { ...headers },
    user,
  };
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

const upload = (user, buffer, name = 'Time Table.xlsx') =>
  call(listHandler, {
    method: 'POST',
    user,
    raw: buffer,
    headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name) },
  });

before(async () => {
  db = await createTestDb();
  setDbDriver(db);
  const add = async (email, role, status) => {
    const { rows } = await query(
      `INSERT INTO app_users (email, role, status) VALUES ($1, $2, $3) RETURNING id, role, status`,
      [email, role, status]
    );
    return rows[0];
  };
  users.admin = await add('admin@example.com', 'admin', 'approved');
  users.student = await add('student@example.com', 'student', 'approved');
  users.other = await add('other@example.com', 'student', 'approved');
  users.pending = await add('pending@example.com', 'student', 'pending');
});

after(async () => {
  setDbDriver(null);
  await db.end();
});

test('signed-out and unapproved callers are turned away', async () => {
  assert.equal((await call(listHandler, { user: null })).status, 401);
  assert.equal((await call(listHandler, { user: users.pending })).status, 403);
});

test('a student cannot upload', async () => {
  const res = await upload(users.student, flatWorkbook());
  assert.equal(res.status, 403);
});

test('only GET/POST/PATCH/DELETE are routed', async () => {
  const res = await call(listHandler, { method: 'DELETE', user: users.admin });
  assert.equal(res.status, 405);
});

let flat; // uploaded flat timetable
let grid;

test('admin upload -> stored unpublished; fetch round-trips the parser shape', async () => {
  const buffer = flatWorkbook();
  const res = await upload(users.admin, buffer, 'EE Time Table (Fall 2026).xlsx');
  assert.equal(res.status, 201);
  flat = res.json.timetable;
  assert.equal(flat.template, 'flat');
  assert.equal(flat.department, 'Computer Science');
  assert.equal(flat.semester, 'Fall 2026');
  assert.equal(flat.isPublished, false);
  assert.equal(flat.sectionCount, 3);
  assert.equal(flat.explicitDurations, false);
  assert.ok(res.json.warnings.length >= 1, 'unreadable row is reported');

  // The stored bytes are the exact upload.
  const stored = await query('SELECT file_bytes, file_sha256, uploaded_by FROM timetables WHERE id = $1', [flat.id]);
  assert.ok(Buffer.from(stored.rows[0].file_bytes).equals(buffer));
  assert.equal(stored.rows[0].uploaded_by, users.admin.id);

  const got = await call(itemHandler, { user: users.admin, query: { id: flat.id } });
  assert.equal(got.status, 200);
  assert.equal(got.json.timetable.id, flat.id);
  assert.deepEqual(got.json.timetable.warnings, res.json.warnings);

  const { parseWorkbook } = await import('../server/parser/index.js');
  const expected = parseWorkbook(buffer, 'EE Time Table (Fall 2026).xlsx').sections;
  // Same shape as the parser, plus a derived per-meeting isLab flag.
  const stripped = got.json.sections.map((s) => ({
    ...s,
    meetings: s.meetings.map(({ isLab, ...m }) => m),
  }));
  assert.deepEqual(stripped, expected);

  const lab = got.json.sections.find((s) => s.code === 'CL1002');
  assert.equal(lab.nameIsLab, true);
  assert.equal(lab.meetings[0].isLab, true);
  assert.equal(lab.meetings[0].durMin, null);
  const theory = got.json.sections.find((s) => s.code === 'CS1002');
  assert.equal(theory.meetings.length, 2); // duplicate row dropped
  assert.equal(theory.meetings[0].isLab, false);
  assert.deepEqual(Object.keys(theory).sort(), ['batch', 'code', 'meetings', 'name', 'nameIsLab', 'section', 'teacher']);
});

test('grid upload keeps explicit durations', async () => {
  const res = await upload(users.admin, gridWorkbook(), 'FSC grid.xlsx');
  assert.equal(res.status, 201);
  grid = res.json.timetable;
  assert.equal(grid.template, 'grid');
  assert.equal(grid.explicitDurations, true);
  const got = await call(itemHandler, { user: users.admin, query: { id: grid.id } });
  const calc = got.json.sections.find((s) => s.code === 'MT1003');
  assert.equal(calc.meetings[0].durMin, 90);
});

test('an exact duplicate upload is a 409', async () => {
  const res = await upload(users.admin, flatWorkbook());
  assert.equal(res.status, 409);
  assert.equal(res.json.details.existingId, flat.id);
  const count = await query('SELECT count(*)::int AS n FROM timetables');
  assert.equal(count.rows[0].n, 2);
});

test('bad uploads: not a timetable, garbage, empty, too large', async () => {
  assert.equal((await upload(users.admin, unrelatedWorkbook())).status, 422);
  assert.equal((await upload(users.admin, Buffer.from('definitely not a spreadsheet'))).status, 422);
  assert.equal((await upload(users.admin, Buffer.alloc(0))).status, 422);
  const big = await call(listHandler, {
    method: 'POST',
    user: users.admin,
    raw: Buffer.alloc(4 * 1024 * 1024 + 1),
  });
  assert.equal(big.status, 413);
  const none = await query('SELECT count(*)::int AS n FROM timetables');
  assert.equal(none.rows[0].n, 2, 'failed uploads store nothing');
});

test('a failed insert rolls back the whole upload', async (t) => {
  t.mock.method(console, 'error', () => {}); // route() logs unexpected errors
  const before = await query('SELECT count(*)::int AS n FROM timetables');
  // A transaction fails midway if a section has a meeting with an impossible day.
  const { parseWorkbook } = await import('../server/parser/index.js');
  const bytes = flatWorkbook({ extraRows: [['ZZ9999', 'Rollback Probe', 'Z', 'T', 'Monday', '9:00 AM', 'R1', '']] });
  assert.ok(parseWorkbook(bytes, 'x.xlsx').sections.length === 4);
  // Sabotage: make the meetings insert fail via a temporary constraint.
  await query('ALTER TABLE meetings ADD CONSTRAINT sabotage CHECK (room <> \'R1\')');
  try {
    assert.equal((await upload(users.admin, bytes, 'sabotage.xlsx')).status, 500);
  } finally {
    await query('ALTER TABLE meetings DROP CONSTRAINT sabotage');
  }
  const after = await query('SELECT count(*)::int AS n FROM timetables');
  assert.equal(after.rows[0].n, before.rows[0].n);
  const orphans = await query(`SELECT count(*)::int AS n FROM sections WHERE code = 'ZZ9999'`);
  assert.equal(orphans.rows[0].n, 0);
});

test('students only see published timetables', async () => {
  let list = await call(listHandler, { user: users.student });
  assert.deepEqual(list.json.timetables, []);
  assert.equal((await call(itemHandler, { user: users.student, query: { id: flat.id } })).status, 404);

  const adminList = await call(listHandler, { user: users.admin });
  assert.equal(adminList.json.timetables.length, 2);

  const pub = await call(itemHandler, { method: 'PATCH', user: users.admin, query: { id: flat.id }, json: { isPublished: true } });
  assert.equal(pub.status, 200);
  assert.equal(pub.json.timetable.isPublished, true);

  list = await call(listHandler, { user: users.student });
  assert.equal(list.json.timetables.length, 1);
  assert.equal(list.json.timetables[0].id, flat.id);
  assert.equal(list.json.timetables[0].sectionCount, 3);
  for (const key of ['id', 'department', 'semester', 'title', 'template', 'sectionCount', 'isPublished', 'uploadedAt']) {
    assert.ok(key in list.json.timetables[0], key);
  }

  const got = await call(itemHandler, { user: users.student, query: { id: flat.id } });
  assert.equal(got.status, 200);
  assert.equal(got.json.sections.length, 3);
  assert.equal(got.json.timetable.warnings, undefined, 'warnings are admin-only');
  assert.equal((await call(itemHandler, { user: users.student, query: { id: grid.id } })).status, 404);
  assert.equal((await call(itemHandler, { user: users.student, query: { id: 'not-a-uuid' } })).status, 404);
});

test('PATCH validates input and is admin only', async () => {
  const q = { id: flat.id };
  assert.equal((await call(itemHandler, { method: 'PATCH', user: users.student, query: q, json: { title: 'x' } })).status, 403);
  assert.equal((await call(itemHandler, { method: 'PATCH', user: users.admin, query: q, json: {} })).status, 422);
  assert.equal((await call(itemHandler, { method: 'PATCH', user: users.admin, query: q, json: { title: '  ' } })).status, 422);
  assert.equal((await call(itemHandler, { method: 'PATCH', user: users.admin, query: q, json: { isPublished: 'yes' } })).status, 422);
  const ok = await call(itemHandler, {
    method: 'PATCH', user: users.admin, query: q, json: { title: ' Renamed ', department: 'CS', semester: 'Fall 2026' },
  });
  assert.equal(ok.json.timetable.title, 'Renamed');
  assert.equal(ok.json.timetable.department, 'CS');
  const missing = await call(itemHandler, {
    method: 'PATCH', user: users.admin, query: { id: '00000000-0000-4000-8000-000000000000' }, json: { title: 'x' },
  });
  assert.equal(missing.status, 404);
});

test('schedules: save, load, replace', async () => {
  const q = { timetableId: flat.id };
  assert.deepEqual((await call(scheduleHandler, { user: users.student, query: q })).json, { schedule: null });

  const body = { sectionKeys: ['CS1002|A', 'CL1002|A1'], colorAssignments: { 'programming fundamentals': 0 } };
  const put = await call(scheduleHandler, { method: 'PUT', user: users.student, query: q, json: body });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.schedule.sectionKeys, body.sectionKeys);
  assert.deepEqual(put.json.schedule.colorAssignments, body.colorAssignments);
  assert.ok(put.json.schedule.updatedAt);

  const got = await call(scheduleHandler, { user: users.student, query: q });
  assert.deepEqual(got.json.schedule.sectionKeys, body.sectionKeys);

  // Another user's schedule is independent.
  assert.deepEqual((await call(scheduleHandler, { user: users.other, query: q })).json, { schedule: null });

  // Replace (and de-duplicate) in place.
  const put2 = await call(scheduleHandler, {
    method: 'PUT', user: users.student, query: q, json: { sectionKeys: ['MT1003|B', 'MT1003|B'], colorAssignments: {} },
  });
  assert.deepEqual(put2.json.schedule.sectionKeys, ['MT1003|B']);
  const rows = await query('SELECT count(*)::int AS n FROM saved_schedules WHERE user_id = $1', [users.student.id]);
  assert.equal(rows.rows[0].n, 1);

  // An empty schedule is valid.
  const empty = await call(scheduleHandler, { method: 'PUT', user: users.student, query: q, json: { sectionKeys: [] } });
  assert.deepEqual(empty.json.schedule, { ...empty.json.schedule, sectionKeys: [], colorAssignments: {} });
});

test('schedules: unknown keys and malformed bodies are rejected', async () => {
  const q = { timetableId: flat.id };
  const put = (json) => call(scheduleHandler, { method: 'PUT', user: users.student, query: q, json });

  const unknown = await put({ sectionKeys: ['CS1002|A', 'NOPE|Z'] });
  assert.equal(unknown.status, 422);
  assert.deepEqual(unknown.json.details.unknownKeys, ['NOPE|Z']);

  // A key from a different timetable is unknown here.
  assert.equal((await put({ sectionKeys: ['CS2001|CS-A'] })).status, 422);

  assert.equal((await put({})).status, 422);
  assert.equal((await put({ sectionKeys: 'CS1002|A' })).status, 422);
  assert.equal((await put({ sectionKeys: [1, 2] })).status, 422);
  assert.equal((await put({ sectionKeys: ['x'.repeat(500)] })).status, 422);
  assert.equal((await put({ sectionKeys: Array.from({ length: 201 }, (_, i) => `K${i}|A`) })).status, 422);
  assert.equal((await put({ sectionKeys: [], colorAssignments: [] })).status, 422);
  assert.equal((await put({ sectionKeys: [], colorAssignments: 'red' })).status, 422);
  assert.equal((await put({ sectionKeys: [], colorAssignments: { a: { nested: true } } })).status, 422);
  assert.equal((await put({ sectionKeys: [], colorAssignments: { a: -1 } })).status, 422);
  const manyColors = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`c${i}`, i]));
  assert.equal((await put({ sectionKeys: [], colorAssignments: manyColors })).status, 422);

  const bad = await call(scheduleHandler, { method: 'PUT', user: users.student, query: q, raw: Buffer.from('{nope') });
  assert.equal(bad.status, 400);
});

test('schedules: unpublished and unknown timetables are 404 for students; pending users are 403', async () => {
  const body = { sectionKeys: [] };
  const hidden = { timetableId: grid.id };
  assert.equal((await call(scheduleHandler, { user: users.student, query: hidden })).status, 404);
  assert.equal((await call(scheduleHandler, { method: 'PUT', user: users.student, query: hidden, json: body })).status, 404);
  assert.equal((await call(scheduleHandler, { user: users.student, query: { timetableId: 'nope' } })).status, 404);
  assert.equal((await call(scheduleHandler, { user: users.pending, query: { timetableId: flat.id } })).status, 403);
  assert.equal((await call(scheduleHandler, { user: null, query: { timetableId: flat.id } })).status, 401);
  // Admins may preview an unpublished timetable's schedule.
  const adminPut = await call(scheduleHandler, {
    method: 'PUT', user: users.admin, query: hidden, json: { sectionKeys: ['MT1003|CS-B'] },
  });
  assert.equal(adminPut.status, 200);
});

test('deleting a timetable cascades to sections, meetings and saved schedules', async () => {
  assert.equal((await call(itemHandler, { method: 'DELETE', user: users.student, query: { id: flat.id } })).status, 403);
  const del = await call(itemHandler, { method: 'DELETE', user: users.admin, query: { id: flat.id } });
  assert.equal(del.status, 200);
  assert.equal((await call(itemHandler, { method: 'DELETE', user: users.admin, query: { id: flat.id } })).status, 404);
  for (const table of ['sections', 'saved_schedules']) {
    const r = await query(`SELECT count(*)::int AS n FROM ${table} WHERE timetable_id = $1`, [flat.id]);
    assert.equal(r.rows[0].n, 0, table);
  }
  const m = await query('SELECT count(*)::int AS n FROM meetings m WHERE NOT EXISTS (SELECT 1 FROM sections s WHERE s.id = m.section_id)');
  assert.equal(m.rows[0].n, 0);
  // The same file can be uploaded again once the original is deleted.
  assert.equal((await upload(users.admin, flatWorkbook())).status, 201);
});

test('real-world sized upload (skipped when the department exports are absent)', {
  skip: fs.existsSync(path.join(ROOT, 'FSC_F26_TT_v1.0.7_14082026.xlsx')) ? false : 'file not present',
}, async () => {
  const bytes = fs.readFileSync(path.join(ROOT, 'FSC_F26_TT_v1.0.7_14082026.xlsx'));
  const res = await upload(users.admin, bytes, 'FSC_F26_TT_v1.0.7_14082026.xlsx');
  assert.equal(res.status, 201);
  const got = await call(itemHandler, { user: users.admin, query: { id: res.json.timetable.id } });
  assert.equal(got.json.sections.length, res.json.timetable.sectionCount);
});

test('route files wire up to the real auth module', async (t) => {
  if (!fs.existsSync(path.join(ROOT, 'server', 'auth.js'))) return t.skip('server/auth.js not present');
  process.env.DATABASE_URL ??= 'postgres://unused';
  for (const file of ['api/timetables/index.js', 'api/timetables/[id].js', 'api/schedules/[timetableId].js']) {
    const mod = await import(new URL(`../${file}`, import.meta.url));
    assert.equal(typeof mod.default, 'function', file);
  }
});
