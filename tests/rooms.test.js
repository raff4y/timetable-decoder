// Free Room Finder: separate, invite-only login + the room data feed.

import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setDbDriver } from '../server/db.js';
import { LIMITS, resetRateLimitMemory } from '../server/rate-limit.js';
import { createApiServer } from '../scripts/dev-server.mjs';
import { hashPassword, verifyPassword } from '../server/rooms/auth.js';
import { createAccount, updateAccount } from '../server/rooms/accounts.js';
import { parseArgs, runCommand } from '../scripts/room-accounts.mjs';
import { createTestDb } from './helpers/pglite-db.js';
import { startAuthEnv } from './helpers/auth-env.js';

let db;
let env;
let server;
let base;

async function call(method, path, { cookie, token, body, rawBody, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') };
}

/** Sign in and return the `name=value` cookie to send back. */
async function signIn(username, password) {
  const r = await call('POST', '/api/rooms/session', { body: { username, password } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.setCookie.split(';')[0];
}

async function addAccount(username = 'staff', password = 'correct-horse-1') {
  const { account } = await createAccount({ username, password });
  return account;
}

async function insertAppAdmin() {
  const { rows } = await db.query(
    `INSERT INTO app_users (auth_user_id, email, display_name, role, status, source, approved_at)
     VALUES ('auth-admin', 'admin@fast.test', 'Admin', 'admin', 'approved', 'preadded', now()) RETURNING *`,
  );
  return rows[0];
}

async function insertTimetable({ department, published, room = 'C-301' }) {
  const { rows } = await db.query(
    `INSERT INTO timetables (department, semester, title, template, section_count, is_published,
                             file_name, file_bytes, file_size, file_sha256)
     VALUES ($1, 'Fall 2026', $1 || ' Timetable', 'flat', 1, $2, 'x.xlsx', '\\x00'::bytea, 1, $3) RETURNING id`,
    [department, published, `sha-${department}`],
  );
  const sec = await db.query(
    `INSERT INTO sections (timetable_id, position, code, name, section, teacher, batch, name_is_lab)
     VALUES ($1, 0, 'CS1001', 'Programming', 'BCS-1A', 'Dr. X', '', false) RETURNING id`,
    [rows[0].id],
  );
  await db.query(
    `INSERT INTO meetings (section_id, position, day_idx, start_min, raw_time, room, dur_min, is_lab)
     VALUES ($1, 0, 0, 510, '8:30am', $2, NULL, false)`,
    [sec.rows[0].id, room],
  );
  return rows[0].id;
}

before(async () => {
  env = await startAuthEnv();
  db = await createTestDb();
  setDbDriver(db);
  server = createApiServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await env.stop();
  setDbDriver(null);
  await db.end();
});

beforeEach(async () => {
  resetRateLimitMemory();
  await db.query('DELETE FROM room_finder_accounts');
  await db.query('DELETE FROM timetables');
  await db.query('DELETE FROM app_users');
  await db.query('DELETE FROM auth_rate_limits');
  await db.query('DELETE FROM audit_log');
});

describe('passwords', () => {
  test('scrypt hashes verify, and tampered or malformed hashes do not', async () => {
    const h = await hashPassword('s3cret-pass');
    assert.match(h, /^scrypt\$32768\$8\$1\$/);
    assert.equal(await verifyPassword('s3cret-pass', h), true);
    assert.equal(await verifyPassword('s3cret-pasS', h), false);
    assert.equal(await verifyPassword('s3cret-pass', h.replace(/.$/, h.endsWith('A') ? 'B' : 'A')), false);
    assert.equal(await verifyPassword('s3cret-pass', 'bcrypt$whatever'), false);
    assert.equal(await verifyPassword('s3cret-pass', 'scrypt$99999999$8$1$AAAA$AAAA'), false);
    assert.notEqual(await hashPassword('s3cret-pass'), h, 'salted');
  });
});

describe('sign in / out', () => {
  test('correct password -> HttpOnly SameSite=Strict cookie scoped to /api/rooms', async () => {
    await addAccount('Staff.One', 'correct-horse-1');
    const r = await call('POST', '/api/rooms/session', { body: { username: '  staff.one ', password: 'correct-horse-1' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.account.username, 'staff.one');
    assert.equal(r.body.account.password_hash, undefined);
    assert.match(r.setCookie, /^rf_session=[A-Za-z0-9_-]{40,};/);
    assert.match(r.setCookie, /Path=\/api\/rooms/);
    assert.match(r.setCookie, /HttpOnly/);
    assert.match(r.setCookie, /SameSite=Strict/);

    const cookie = r.setCookie.split(';')[0];
    const me = await call('GET', '/api/rooms/session', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body.account.username, 'staff.one');

    const { rows } = await db.query('SELECT token_hash FROM room_finder_sessions');
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, cookie.split('=')[1], 'only the hash is stored');
  });

  test('wrong password and unknown username look the same', async () => {
    await addAccount();
    const wrong = await call('POST', '/api/rooms/session', { body: { username: 'staff', password: 'nope-nope-nope' } });
    const unknown = await call('POST', '/api/rooms/session', { body: { username: 'ghost', password: 'nope-nope-nope' } });
    for (const r of [wrong, unknown]) {
      assert.equal(r.status, 401);
      assert.equal(r.body.details.code, 'INVALID_CREDENTIALS');
      assert.equal(r.setCookie, null);
    }
    assert.equal(wrong.body.error, unknown.body.error);
  });

  test('missing fields are 422; a non-JSON login is 415', async () => {
    assert.equal((await call('POST', '/api/rooms/session', { body: { username: 'staff' } })).status, 422);
    const form = await call('POST', '/api/rooms/session', {
      rawBody: 'username=staff&password=correct-horse-1',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(form.status, 415);
  });

  test('too many attempts -> 429 RATE_LIMITED', async () => {
    await addAccount();
    let last;
    for (let i = 0; i < 11; i++) {
      last = await call('POST', '/api/rooms/session', { body: { username: 'staff', password: `wrong-${i}-xxxx` } });
    }
    assert.equal(last.status, 429);
    assert.equal(last.body.details.code, 'RATE_LIMITED');
  });

  test('sign out deletes the session and clears the cookie', async () => {
    await addAccount();
    const cookie = await signIn('staff', 'correct-horse-1');
    const out = await call('DELETE', '/api/rooms/session', { cookie });
    assert.equal(out.status, 200);
    assert.match(out.setCookie, /^rf_session=;.*Max-Age=0/);
    assert.equal((await call('GET', '/api/rooms/session', { cookie })).status, 401);
    // Signing out without a session is harmless.
    assert.equal((await call('DELETE', '/api/rooms/session')).status, 200);
  });

  test('expired sessions and junk cookies are 401', async () => {
    await addAccount();
    const cookie = await signIn('staff', 'correct-horse-1');
    await db.query(`UPDATE room_finder_sessions SET expires_at = now() - interval '1 minute'`);
    assert.equal((await call('GET', '/api/rooms/session', { cookie })).status, 401);
    assert.equal((await call('GET', '/api/rooms/session', { cookie: 'rf_session=forged' })).status, 401);
    assert.equal((await call('GET', '/api/rooms/session')).status, 401);
  });

  test('junk session cookies count as failed sign-ins: 429 after too many from one IP', async () => {
    const saved = LIMITS.authFailuresPerIp.limit;
    LIMITS.authFailuresPerIp.limit = 3;
    try {
      for (let i = 0; i < 3; i++) {
        assert.equal((await call('GET', '/api/rooms/data', { cookie: `rf_session=guess${i}` })).status, 401);
      }
      assert.equal((await call('GET', '/api/rooms/data', { cookie: 'rf_session=guess9' })).status, 429);
    } finally {
      LIMITS.authFailuresPerIp.limit = saved;
    }
  });

  test('signed-in Room Finder calls are limited per account', async () => {
    await addAccount();
    const cookie = await signIn('staff', 'correct-horse-1');
    const saved = LIMITS.roomRequests.limit;
    LIMITS.roomRequests.limit = 2;
    try {
      for (let i = 0; i < 2; i++) assert.equal((await call('GET', '/api/rooms/data', { cookie })).status, 200);
      assert.equal((await call('GET', '/api/rooms/data', { cookie })).status, 429);
    } finally {
      LIMITS.roomRequests.limit = saved;
    }
  });

  test('a disabled account cannot sign in, and is signed out at once', async () => {
    const account = await addAccount();
    const cookie = await signIn('staff', 'correct-horse-1');
    await updateAccount(account.id, { status: 'disabled' });
    assert.equal((await call('GET', '/api/rooms/data', { cookie })).status, 401);
    const again = await call('POST', '/api/rooms/session', { body: { username: 'staff', password: 'correct-horse-1' } });
    assert.equal(again.status, 403);
    assert.equal(again.body.details.code, 'ACCOUNT_DISABLED');
    // ...but a wrong password still just says "incorrect".
    const wrong = await call('POST', '/api/rooms/session', { body: { username: 'staff', password: 'wrong-wrong' } });
    assert.equal(wrong.body.details.code, 'INVALID_CREDENTIALS');
  });
});

describe('separate from the timetable login', () => {
  test('a Neon Auth admin token does not open the Room Finder', async () => {
    await insertAppAdmin();
    const token = await env.sign({ sub: 'auth-admin', email: 'admin@fast.test', emailVerified: true });
    assert.equal((await call('GET', '/api/me', { token })).status, 200, 'token is valid for the timetable tool');
    assert.equal((await call('GET', '/api/rooms/data', { token })).status, 401);
    assert.equal((await call('GET', '/api/rooms/session', { token })).status, 401);
  });

  test('a Room Finder session does not open the timetable tool', async () => {
    await addAccount();
    const cookie = await signIn('staff', 'correct-horse-1');
    assert.equal((await call('GET', '/api/me', { cookie })).status, 401);
    assert.equal((await call('GET', '/api/timetables', { cookie })).status, 401);
  });

  test('a timetable-tool email does not exist as a Room Finder username', async () => {
    await insertAppAdmin();
    const r = await call('POST', '/api/rooms/session', { body: { username: 'admin@fast.test', password: 'anything-at-all' } });
    assert.equal(r.status, 401);
  });
});

describe('room data', () => {
  test('signed in: every published timetable with its sections; unpublished ones are left out', async () => {
    await insertTimetable({ department: 'EE', published: true, room: 'D - 6' });
    await insertTimetable({ department: 'FSC', published: true, room: 'C-301' });
    await insertTimetable({ department: 'Draft', published: false });
    await addAccount();
    const cookie = await signIn('staff', 'correct-horse-1');

    const r = await call('GET', '/api/rooms/data', { cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.timetables.map((t) => t.department), ['EE', 'FSC']);
    const ee = r.body.timetables[0];
    assert.equal(ee.semester, 'Fall 2026');
    assert.equal(ee.sections.length, 1);
    assert.deepEqual(ee.sections[0].meetings[0], {
      dayIdx: 0, startMin: 510, rawTime: '8:30am', room: 'D - 6', durMin: null, isLab: false,
    });
  });

  test('signed out -> 401', async () => {
    await insertTimetable({ department: 'EE', published: true });
    const r = await call('GET', '/api/rooms/data');
    assert.equal(r.status, 401);
    assert.equal(r.body.details.code, 'ROOMS_SIGNED_OUT');
  });
});

describe('change own password', () => {
  test('checks the current password, keeps this session, ends the others', async () => {
    await addAccount();
    const here = await signIn('staff', 'correct-horse-1');
    const elsewhere = await signIn('staff', 'correct-horse-1');

    const wrong = await call('PATCH', '/api/rooms/session', { cookie: here, body: { currentPassword: 'nope-nope', newPassword: 'brand-new-pass' } });
    assert.equal(wrong.status, 403);
    const weak = await call('PATCH', '/api/rooms/session', { cookie: here, body: { currentPassword: 'correct-horse-1', newPassword: 'short' } });
    assert.equal(weak.status, 422);
    assert.equal(weak.body.details.code, 'WEAK_PASSWORD');
    const same = await call('PATCH', '/api/rooms/session', { cookie: here, body: { currentPassword: 'correct-horse-1', newPassword: 'correct-horse-1' } });
    assert.equal(same.status, 422);

    const ok = await call('PATCH', '/api/rooms/session', { cookie: here, body: { currentPassword: 'correct-horse-1', newPassword: 'brand-new-pass' } });
    assert.equal(ok.status, 200);
    assert.equal((await call('GET', '/api/rooms/session', { cookie: here })).status, 200);
    assert.equal((await call('GET', '/api/rooms/session', { cookie: elsewhere })).status, 401);

    const old = await call('POST', '/api/rooms/session', { body: { username: 'staff', password: 'correct-horse-1' } });
    assert.equal(old.status, 401);
    await signIn('staff', 'brand-new-pass');
  });

  test('signed out -> 401', async () => {
    const r = await call('PATCH', '/api/rooms/session', { body: { currentPassword: 'a', newPassword: 'bbbbbbbbbb' } });
    assert.equal(r.status, 401);
  });
});

describe('admin management', () => {
  async function adminToken() {
    await insertAppAdmin();
    return env.sign({ sub: 'auth-admin', email: 'admin@fast.test', emailVerified: true });
  }

  test('only timetable-tool admins can manage accounts', async () => {
    await db.query(
      `INSERT INTO app_users (auth_user_id, email, role, status, source) VALUES ('auth-s', 's@fast.test', 'student', 'approved', 'signup')`,
    );
    const student = await env.sign({ sub: 'auth-s', email: 's@fast.test', emailVerified: true });
    assert.equal((await call('GET', '/api/admin/room-accounts', { token: student })).status, 403);
    assert.equal((await call('POST', '/api/admin/room-accounts', { token: student, body: { username: 'x-user' } })).status, 403);
    assert.equal((await call('GET', '/api/admin/room-accounts')).status, 401);

    // A Room Finder session is not an admin credential either.
    await addAccount();
    const cookie = await signIn('staff', 'correct-horse-1');
    assert.equal((await call('GET', '/api/admin/room-accounts', { cookie })).status, 401);
  });

  test('create (generated password), list, reset, disable, delete', async () => {
    const token = await adminToken();

    const created = await call('POST', '/api/admin/room-accounts', { token, body: { username: 'Front.Desk', displayName: 'Front Desk' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.account.username, 'front.desk');
    assert.equal(created.body.account.status, 'active');
    assert.match(created.body.temporaryPassword, /^[A-Za-z2-9]{16}$/);
    const id = created.body.account.id;

    const dup = await call('POST', '/api/admin/room-accounts', { token, body: { username: 'front.desk' } });
    assert.equal(dup.status, 409);
    const bad = await call('POST', '/api/admin/room-accounts', { token, body: { username: 'a b' } });
    assert.equal(bad.status, 422);
    const weak = await call('POST', '/api/admin/room-accounts', { token, body: { username: 'other', password: 'short' } });
    assert.equal(weak.status, 422);

    const list = await call('GET', '/api/admin/room-accounts', { token });
    assert.deepEqual(list.body.accounts.map((a) => a.username), ['front.desk']);
    assert.equal(list.body.accounts[0].password_hash, undefined);

    const cookie = await signIn('front.desk', created.body.temporaryPassword);
    const reset = await call('PATCH', `/api/admin/room-accounts?id=${id}`, { token, body: { resetPassword: true } });
    assert.equal(reset.status, 200);
    assert.notEqual(reset.body.temporaryPassword, created.body.temporaryPassword);
    assert.equal((await call('GET', '/api/rooms/session', { cookie })).status, 401, 'reset signs out');
    await signIn('front.desk', reset.body.temporaryPassword);

    const disabled = await call('PATCH', `/api/admin/room-accounts?id=${id}`, { token, body: { status: 'disabled' } });
    assert.equal(disabled.body.account.status, 'disabled');
    assert.equal(disabled.body.temporaryPassword, undefined);
    assert.equal((await call('PATCH', `/api/admin/room-accounts?id=${id}`, { token, body: { status: 'gone' } })).status, 422);
    assert.equal((await call('PATCH', `/api/admin/room-accounts?id=${id}`, { token, body: {} })).status, 422);

    assert.equal((await call('DELETE', `/api/admin/room-accounts?id=${id}`, { token })).status, 200);
    assert.equal((await call('DELETE', `/api/admin/room-accounts?id=${id}`, { token })).status, 404);
    assert.equal((await call('PATCH', '/api/admin/room-accounts?id=not-a-uuid', { token, body: { status: 'active' } })).status, 404);

    const { rows: audit } = await db.query('SELECT action, summary, details FROM audit_log ORDER BY id');
    assert.deepEqual(audit.map((a) => a.action), ['room.create', 'room.update', 'room.update', 'room.delete']);
    assert.equal(audit[1].summary, 'Room Finder account front.desk: password reset');
    assert.equal(audit[2].summary, 'Room Finder account front.desk: disabled');
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(reset.body.temporaryPassword), 'no passwords in the audit log');
  });
});

describe('CLI', () => {
  test('parseArgs', () => {
    assert.deepEqual(parseArgs(['add', 'desk', '--name', 'Front Desk']), { command: 'add', username: 'desk', name: 'Front Desk' });
    assert.deepEqual(parseArgs(['list']), { command: 'list', username: undefined, name: undefined });
    assert.throws(() => parseArgs(['add', 'desk', '--password', 'x']), /Unknown option/);
  });

  test('add, list, reset-password, disable, enable, remove', async () => {
    const lines = [];
    const out = (l) => lines.push(l);

    await runCommand({ command: 'add', username: 'Desk', name: 'Front Desk' }, out);
    const pw = /Password: (\S+)/.exec(lines.join('\n'))[1];
    await signIn('desk', pw);

    lines.length = 0;
    await runCommand({ command: 'list' }, out);
    assert.match(lines[0], /^desk\s+active\s+last sign-in \d{4}-/);

    lines.length = 0;
    await runCommand({ command: 'reset-password', username: 'desk' }, out);
    const pw2 = /: (\S+)$/.exec(lines[0])[1];
    assert.notEqual(pw2, pw);
    await signIn('desk', pw2);

    await runCommand({ command: 'disable', username: 'desk' }, out);
    assert.equal((await call('POST', '/api/rooms/session', { body: { username: 'desk', password: pw2 } })).status, 403);
    await runCommand({ command: 'enable', username: 'desk' }, out);
    await signIn('desk', pw2);

    await runCommand({ command: 'remove', username: 'desk' }, out);
    await assert.rejects(runCommand({ command: 'remove', username: 'desk' }, out), /not found/);
    await assert.rejects(runCommand({ command: 'add' }, out), /needs a username/);
    await assert.rejects(runCommand({ command: 'frobnicate', username: 'x' }, out), /Unknown command/);
  });
});
