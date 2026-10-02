import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setDbDriver } from '../server/db.js';
import { clientIp, LIMITS, normaliseIp, resetRateLimitMemory } from '../server/rate-limit.js';
import { HttpError } from '../server/http.js';
import { requireAdmin, requireApprovedUser, requireUser } from '../server/auth.js';
import { createApiServer, resolveRoute } from '../scripts/dev-server.mjs';
import { createTestDb } from './helpers/pglite-db.js';
import { startAuthEnv } from './helpers/auth-env.js';

let db;
let env;
let server;
let base;

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

const tokenFor = (sub, email, extra = {}) => env.sign({ sub, email, emailVerified: true, ...extra });

async function insertAdmin(email = 'admin@fast.test', authId = 'auth-admin') {
  const { rows } = await db.query(
    `INSERT INTO app_users (auth_user_id, email, display_name, role, status, source, approved_at)
     VALUES ($1, $2, 'Admin', 'admin', 'approved', 'preadded', now()) RETURNING *`,
    [authId, email],
  );
  return rows[0];
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
  await db.query('DELETE FROM app_users');
  await db.query('DELETE FROM auth_rate_limits');
  await db.query('DELETE FROM audit_log');
  env.resetCalls.length = 0;
});

describe('token verification', () => {
  test('no token -> 401', async () => {
    const r = await call('GET', '/api/me');
    assert.equal(r.status, 401);
  });

  test('garbage, forged, wrong-issuer and expired tokens -> 401', async () => {
    const bad = [
      'not-a-jwt',
      await env.sign({ sub: 'x', email: 'x@y.co', emailVerified: true }, { key: env.foreignKey }),
      await env.sign({ sub: 'x', email: 'x@y.co', emailVerified: true }, { issuer: 'https://evil.example' }),
      await env.sign({ sub: 'x', email: 'x@y.co', emailVerified: true }, { expiresIn: '-1m' }),
    ];
    for (const token of bad) {
      const r = await call('GET', '/api/me', { token });
      assert.equal(r.status, 401, 'bad token must be rejected');
    }
    const { rows } = await db.query('SELECT count(*)::int AS n FROM app_users');
    assert.equal(rows[0].n, 0, 'no user rows created from bad tokens');
  });

  test('wrong HTTP method -> 405', async () => {
    const r = await call('POST', '/api/me', { token: await tokenFor('u1', 'u1@fast.test') });
    assert.equal(r.status, 405);
  });
});

describe('sign-up and approval', () => {
  test('first /api/me creates a pending signup row; idempotent', async () => {
    const token = await tokenFor('auth-1', 'New.Student@FAST.test', { name: 'New Student' });
    const a = await call('GET', '/api/me', { token });
    assert.equal(a.status, 200);
    assert.deepEqual(
      { ...a.body.user, id: undefined },
      { id: undefined, email: 'New.Student@FAST.test'.toLowerCase(), displayName: 'New Student', role: 'student', status: 'pending', source: 'signup' },
    );
    const b = await call('GET', '/api/me', { token });
    assert.equal(b.body.user.id, a.body.user.id);
    assert.equal((await db.query('SELECT count(*)::int n FROM app_users')).rows[0].n, 1);
  });

  test('pending user: /me ok, approved-only and admin routes 403', async () => {
    const token = await tokenFor('auth-1', 'p@fast.test');
    assert.equal((await call('GET', '/api/me', { token })).status, 200);

    const req = { headers: { authorization: `Bearer ${token}` } };
    await assert.rejects(requireApprovedUser(req), (e) => e instanceof HttpError && e.status === 403 && e.details.status === 'pending');
    await assert.rejects(requireAdmin(req), (e) => e instanceof HttpError && e.status === 403);
    const allowed = await requireUser(req, { allowPending: true });
    assert.equal(allowed.status, 'pending');
    await assert.rejects(requireUser({ headers: {} }), (e) => e instanceof HttpError && e.status === 401);

    assert.equal((await call('GET', '/api/admin/users', { token })).status, 403);
    assert.equal((await call('POST', '/api/admin/users', { token, body: { email: 'z@fast.test' } })).status, 403);
  });

  test('admin approves a signup; the user becomes approved, student cannot use admin APIs', async () => {
    const admin = await insertAdmin();
    const adminToken = await tokenFor('auth-admin', 'admin@fast.test');
    const studentToken = await tokenFor('auth-s', 's@fast.test');
    const me = (await call('GET', '/api/me', { token: studentToken })).body.user;

    const pending = await call('GET', '/api/admin/users?status=pending', { token: adminToken });
    assert.equal(pending.status, 200);
    assert.deepEqual(pending.body.users.map((u) => u.email), ['s@fast.test']);
    assert.ok(pending.body.users[0].createdAt);

    const patched = await call('PATCH', `/api/admin/users/${me.id}`, { token: adminToken, body: { status: 'approved' } });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.user.status, 'approved');
    assert.ok(patched.body.user.approvedAt);
    const row = (await db.query('SELECT approved_by FROM app_users WHERE id = $1', [me.id])).rows[0];
    assert.equal(row.approved_by, admin.id);

    const after = await call('GET', '/api/me', { token: studentToken });
    assert.equal(after.body.user.status, 'approved');
    const u = await requireApprovedUser({ headers: { authorization: `Bearer ${studentToken}` } });
    assert.equal(u.email, 's@fast.test');
    assert.equal((await call('GET', '/api/admin/users', { token: studentToken })).status, 403);
  });

  test('rejected / disabled users cannot use approved-only routes; admin disabling takes effect at once', async () => {
    await insertAdmin();
    const adminToken = await tokenFor('auth-admin', 'admin@fast.test');
    const studentToken = await tokenFor('auth-s', 's@fast.test');
    const me = (await call('GET', '/api/me', { token: studentToken })).body.user;
    await call('PATCH', `/api/admin/users/${me.id}`, { token: adminToken, body: { status: 'approved' } });
    const req = { headers: { authorization: `Bearer ${studentToken}` } };
    await requireApprovedUser(req);
    await call('PATCH', `/api/admin/users/${me.id}`, { token: adminToken, body: { status: 'disabled' } });
    // Every token issued before the revocation is dead at once, /api/me included.
    await assert.rejects(requireApprovedUser(req), (e) => e.status === 401 && e.details.code === 'SESSION_REVOKED');
    const old = await call('GET', '/api/me', { token: studentToken });
    assert.equal(old.status, 401);
    assert.equal(old.body.details.code, 'SESSION_REVOKED');
    // A token minted after the revocation (signing in again) is refused too.
    await db.query(`UPDATE app_users SET sessions_revoked_at = now() - interval '10 seconds' WHERE id = $1`, [me.id]);
    const fresh = await tokenFor('auth-s', 's@fast.test');
    const r = await call('GET', '/api/me', { token: fresh });
    assert.equal(r.status, 403);
    assert.equal(r.body.details.code, 'ACCOUNT_REVOKED');
    assert.equal((await call('GET', '/api/timetables', { token: fresh })).status, 403);
  });

  test('admin can rename a user; user changes are audited; lists carry lastSeenAt + scheduleCount', async () => {
    await insertAdmin();
    const adminToken = await tokenFor('auth-admin', 'admin@fast.test');
    const studentToken = await tokenFor('auth-s', 's@fast.test');
    const me = (await call('GET', '/api/me', { token: studentToken })).body.user;

    const both = await call('PATCH', `/api/admin/users/${me.id}`, {
      token: adminToken,
      body: { status: 'approved', displayName: '  Sara S  ' },
    });
    assert.equal(both.status, 200);
    assert.equal(both.body.user.displayName, 'Sara S');
    await call('PATCH', `/api/admin/users/${me.id}`, { token: adminToken, body: { role: 'admin' } });
    await call('PATCH', `/api/admin/users/${me.id}`, { token: adminToken, body: { displayName: 'Sara' } });
    await call('PATCH', `/api/admin/users/${me.id}`, { token: adminToken, body: { displayName: 'Sara' } }); // no-op
    assert.equal((await call('PATCH', `/api/admin/users/${me.id}`, { token: adminToken, body: { displayName: 5 } })).status, 422);

    const log = await db.query('SELECT action, summary, actor_email FROM audit_log ORDER BY id');
    assert.deepEqual(log.rows.map((r) => r.action), ['user.approve', 'user.role', 'user.rename']);
    assert.equal(log.rows[0].actor_email, 'admin@fast.test');
    assert.match(log.rows[1].summary, /from student to admin/);

    const list = await call('GET', '/api/admin/users', { token: adminToken });
    const row = list.body.users.find((u) => u.email === 's@fast.test');
    assert.ok(row.lastSeenAt, 'signed-in requests record last seen');
    assert.equal(row.scheduleCount, 0);
  });

  test('admin PATCH validation', async () => {
    await insertAdmin();
    const adminToken = await tokenFor('auth-admin', 'admin@fast.test');
    const bad = await call('PATCH', '/api/admin/users/not-a-uuid', { token: adminToken, body: { status: 'approved' } });
    assert.equal(bad.status, 404);
    const missing = await call('PATCH', '/api/admin/users/00000000-0000-4000-8000-000000000000', { token: adminToken, body: { status: 'approved' } });
    assert.equal(missing.status, 404);
    const empty = await call('PATCH', '/api/admin/users/00000000-0000-4000-8000-000000000000', { token: adminToken, body: {} });
    assert.equal(empty.status, 422);
    const weird = await call('PATCH', '/api/admin/users/00000000-0000-4000-8000-000000000000', { token: adminToken, body: { role: 'root' } });
    assert.equal(weird.status, 422);
    assert.equal((await call('GET', '/api/admin/users?status=bogus', { token: adminToken })).status, 422);
  });
});

describe('pre-added accounts and email-verified linking', () => {
  test('admin pre-adds; duplicate -> 409; bad input -> 422', async () => {
    await insertAdmin();
    const adminToken = await tokenFor('auth-admin', 'admin@fast.test');
    const ok = await call('POST', '/api/admin/users', { token: adminToken, body: { email: 'Pre@Fast.test', displayName: 'Pre Added', role: 'student' } });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.user.email, 'pre@fast.test');
    assert.equal(ok.body.user.status, 'approved');
    assert.equal(ok.body.user.source, 'preadded');
    const dup = await call('POST', '/api/admin/users', { token: adminToken, body: { email: 'pre@fast.test' } });
    assert.equal(dup.status, 409);
    assert.equal((await call('POST', '/api/admin/users', { token: adminToken, body: { email: 'nope' } })).status, 422);
    assert.equal((await call('POST', '/api/admin/users', { token: adminToken, body: { email: 'a@b.co', role: 'god' } })).status, 422);
  });

  test('links to a pre-added row only when the email is verified', async () => {
    await insertAdmin();
    const adminToken = await tokenFor('auth-admin', 'admin@fast.test');
    await call('POST', '/api/admin/users', { token: adminToken, body: { email: 'pre@fast.test', displayName: 'Pre' } });

    const unverified = await env.sign({ sub: 'squatter', email: 'pre@fast.test', emailVerified: false });
    const denied = await call('GET', '/api/me', { token: unverified });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.details.code, 'EMAIL_NOT_VERIFIED');
    let row = (await db.query(`SELECT * FROM app_users WHERE email = 'pre@fast.test'`)).rows[0];
    assert.equal(row.auth_user_id, null, 'must not link');
    assert.equal((await db.query('SELECT count(*)::int n FROM app_users')).rows[0].n, 2, 'no extra row created');

    // A token with no emailVerified claim at all is treated as unverified.
    const noClaim = await env.sign({ sub: 'squatter2', email: 'pre@fast.test' });
    assert.equal((await call('GET', '/api/me', { token: noClaim })).status, 403);

    const verified = await env.sign({ sub: 'real-owner', email: 'PRE@fast.test', emailVerified: true });
    const ok = await call('GET', '/api/me', { token: verified });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.status, 'approved');
    assert.equal(ok.body.user.source, 'preadded');
    row = (await db.query(`SELECT * FROM app_users WHERE email = 'pre@fast.test'`)).rows[0];
    assert.equal(row.auth_user_id, 'real-owner');

    // The squatter still can't get in after the real owner linked.
    assert.equal((await call('GET', '/api/me', { token: unverified })).status, 403);
  });

  test('a verified re-sign-up (old Neon account deleted) re-links the same row', async () => {
    await insertAdmin();
    const adminToken = await tokenFor('auth-admin', 'admin@fast.test');
    await call('POST', '/api/admin/users', { token: adminToken, body: { email: 'pre@fast.test' } });
    await call('GET', '/api/me', { token: await tokenFor('old-id', 'pre@fast.test') });
    const again = await call('GET', '/api/me', { token: await tokenFor('new-id', 'pre@fast.test') });
    assert.equal(again.status, 200);
    assert.equal(again.body.user.status, 'approved');
    assert.equal((await db.query(`SELECT auth_user_id FROM app_users WHERE email = 'pre@fast.test'`)).rows[0].auth_user_id, 'new-id');
  });

  test('an unverified email gets no row at all (403 EMAIL_NOT_VERIFIED)', async () => {
    const t = await env.sign({ sub: 'u9', email: 'fresh@fast.test', emailVerified: false });
    const r = await call('GET', '/api/me', { token: t });
    assert.equal(r.status, 403);
    assert.equal(r.body.details.code, 'EMAIL_NOT_VERIFIED');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM app_users')).rows[0].n, 0);
  });
});

describe('password reset', () => {
  async function setupUsers() {
    await insertAdmin();
    const adminToken = await tokenFor('auth-admin', 'admin@fast.test');
    await call('POST', '/api/admin/users', { token: adminToken, body: { email: 'pre@fast.test' } });
    await call('GET', '/api/me', { token: await tokenFor('s1', 'self@fast.test') });
  }
  const reset = (email, extra = {}) =>
    call('POST', '/api/auth/password-reset', {
      body: { email, redirectTo: `${base}/login.html?view=reset`, ...extra },
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });

  test('self-signup account: Neon reset email is requested; pre-added: refused; identical responses', async () => {
    await setupUsers();
    const allowed = await reset('self@fast.test');
    const refused = await reset('pre@fast.test');
    const unknown = await reset('nobody@fast.test');
    for (const r of [allowed, refused, unknown]) {
      assert.equal(r.status, 200);
    }
    assert.equal(allowed.text, refused.text);
    assert.equal(allowed.text, unknown.text);
    assert.deepEqual(allowed.body, { ok: true });

    const emails = env.resetCalls.map((c) => c.body.email).sort();
    assert.deepEqual(emails, ['nobody@fast.test', 'self@fast.test'], 'pre-added email never reaches Neon');
    assert.equal(env.resetCalls[0].url, '/neondb/auth/request-password-reset');
    assert.equal(env.resetCalls[0].body.redirectTo, `${base}/login.html?view=reset`);
  });

  test('redirectTo to a foreign origin is replaced by our own login page', async () => {
    await setupUsers();
    await reset('self@fast.test', { redirectTo: 'https://evil.example/steal' });
    assert.equal(env.resetCalls.length, 1);
    assert.equal(env.resetCalls[0].body.redirectTo, `${base}/login.html?view=reset`);
  });

  test('on Vercel the reset link origin comes from configuration, never from request headers', async () => {
    await setupUsers();
    const saved = { VERCEL: process.env.VERCEL, APP_ORIGIN: process.env.APP_ORIGIN };
    process.env.VERCEL = '1';
    process.env.APP_ORIGIN = 'https://timetable.example';
    try {
      const r = await call('POST', '/api/auth/password-reset', {
        body: { email: 'self@fast.test', redirectTo: 'https://evil.example/login.html' },
        headers: { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' },
      });
      assert.equal(r.status, 200);
      assert.equal(env.resetCalls.at(-1).body.redirectTo, 'https://timetable.example/login.html?view=reset');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('bad email -> 422; throttled per IP+email -> 429', async () => {
    await setupUsers();
    assert.equal((await reset('not-an-email')).status, 422);
    for (let i = 0; i < 3; i++) assert.equal((await reset('self@fast.test')).status, 200);
    const limited = await reset('self@fast.test');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.details.code, 'RATE_LIMITED');
    // Same limit for refused accounts, so the 429 reveals nothing either.
    for (let i = 0; i < 3; i++) await reset('pre@fast.test');
    assert.equal((await reset('pre@fast.test')).status, 429);
    assert.equal(env.resetCalls.length, 3);
  });
});

describe('admin lockout guard', () => {
  test('the only admin cannot demote, reject or disable themselves', async () => {
    const admin = await insertAdmin();
    const token = await tokenFor('auth-admin', 'admin@fast.test');
    for (const body of [{ role: 'student' }, { status: 'disabled' }, { status: 'rejected' }, { status: 'pending' }, { role: 'student', status: 'approved' }]) {
      const r = await call('PATCH', `/api/admin/users/${admin.id}`, { token, body });
      assert.equal(r.status, 409, JSON.stringify(body));
      assert.equal(r.body.details.code, 'LAST_ADMIN');
    }
    const row = (await db.query('SELECT role, status FROM app_users WHERE id = $1', [admin.id])).rows[0];
    assert.deepEqual(row, { role: 'admin', status: 'approved' });
    // No-op changes are fine.
    assert.equal((await call('PATCH', `/api/admin/users/${admin.id}`, { token, body: { role: 'admin', status: 'approved' } })).status, 200);
  });

  test('with a second admin, an admin may step down; the new last admin is then protected', async () => {
    const a1 = await insertAdmin('a1@fast.test', 'auth-a1');
    const a2 = await insertAdmin('a2@fast.test', 'auth-a2');
    const t1 = await tokenFor('auth-a1', 'a1@fast.test');
    const t2 = await tokenFor('auth-a2', 'a2@fast.test');
    const down = await call('PATCH', `/api/admin/users/${a1.id}`, { token: t1, body: { role: 'student' } });
    assert.equal(down.status, 200);
    assert.equal(down.body.user.role, 'student');
    // a1 is no longer an admin: its token no longer opens admin routes.
    assert.equal((await call('GET', '/api/admin/users', { token: t1 })).status, 403);
    // a2 is now the only admin and is protected, including from other people.
    const r = await call('PATCH', `/api/admin/users/${a2.id}`, { token: t2, body: { status: 'disabled' } });
    assert.equal(r.status, 409);
  });

  test('one admin cannot disable the last other admin if that leaves none', async () => {
    // a1 demotes a2 (allowed, a1 remains); a2 is a student, so cannot act. Covered
    // by the role checks above; here check that a disabled admin does not count.
    const a1 = await insertAdmin('a1@fast.test', 'auth-a1');
    const a2 = await insertAdmin('a2@fast.test', 'auth-a2');
    const t1 = await tokenFor('auth-a1', 'a1@fast.test');
    assert.equal((await call('PATCH', `/api/admin/users/${a2.id}`, { token: t1, body: { status: 'disabled' } })).status, 200);
    assert.equal((await call('PATCH', `/api/admin/users/${a1.id}`, { token: t1, body: { role: 'student' } })).status, 409);
  });
});

describe('token hardening', () => {
  test('tokens without iat, too old, issued in the future, or oversized -> 401', async () => {
    const claims = { sub: 'x', email: 'x@fast.test', emailVerified: true };
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      await env.sign(claims, { issuedAt: false }),
      await env.sign(claims, { issuedAt: now - 2 * 3600, expiresIn: '1d' }),
      await env.sign(claims, { issuedAt: now + 3600 }),
      (await env.sign(claims)) + 'x'.repeat(9000),
    ];
    for (const token of bad) assert.equal((await call('GET', '/api/me', { token })).status, 401);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM app_users')).rows[0].n, 0);
  });

  test('a malformed Authorization header is not a token', async () => {
    for (const value of ['Basic abc', 'Bearer', 'Bearer a.b', `Bearer ${await tokenFor('u1', 'u1@fast.test')} extra`]) {
      const r = await call('GET', '/api/me', { headers: { Authorization: value } });
      assert.equal(r.status, 401, value);
    }
  });

  test('repeated bad tokens from one IP -> 429 with Retry-After; good tokens still work', async () => {
    const saved = LIMITS.authFailuresPerIp.limit;
    LIMITS.authFailuresPerIp.limit = 3;
    try {
      const forged = await env.sign({ sub: 'x', email: 'x@y.co', emailVerified: true }, { key: env.foreignKey });
      for (let i = 0; i < 3; i++) assert.equal((await call('GET', '/api/me', { token: forged })).status, 401);
      const res = await fetch(base + '/api/me', { headers: { Authorization: `Bearer ${forged}` } });
      assert.equal(res.status, 429);
      assert.ok(Number(res.headers.get('retry-after')) > 0);
      assert.equal((await res.json()).details.code, 'RATE_LIMITED');
      // A legitimate user behind the same address is not locked out.
      assert.equal((await call('GET', '/api/me', { token: await tokenFor('u1', 'u1@fast.test') })).status, 200);
    } finally {
      LIMITS.authFailuresPerIp.limit = saved;
    }
  });
});

describe('rate limiting', () => {
  test('per-account request budget, enforced by the shared table even across instances', async () => {
    const saved = LIMITS.userRequests.limit;
    LIMITS.userRequests.limit = 4;
    try {
      const token = await tokenFor('u1', 'u1@fast.test');
      for (let i = 0; i < 2; i++) assert.equal((await call('GET', '/api/me', { token })).status, 200);
      // A "new instance" (empty memory) still sees the shared count.
      resetRateLimitMemory();
      for (let i = 0; i < 2; i++) assert.equal((await call('GET', '/api/me', { token })).status, 200);
      const r = await call('GET', '/api/me', { token });
      assert.equal(r.status, 429);
      assert.equal(r.body.details.code, 'RATE_LIMITED');
      // Another account has its own budget.
      assert.equal((await call('GET', '/api/me', { token: await tokenFor('u2', 'u2@fast.test') })).status, 200);
    } finally {
      LIMITS.userRequests.limit = saved;
    }
  });

  test('writes have a tighter budget than reads', async () => {
    await insertAdmin();
    const token = await tokenFor('auth-admin', 'admin@fast.test');
    const target = (await call('POST', '/api/admin/users', { token, body: { email: 't@fast.test' } })).body.user;
    const saved = LIMITS.userWrites.limit;
    LIMITS.userWrites.limit = 2;
    try {
      assert.equal((await call('PATCH', `/api/admin/users/${target.id}`, { token, body: { displayName: 'A' } })).status, 200);
      assert.equal((await call('PATCH', `/api/admin/users/${target.id}`, { token, body: { displayName: 'B' } })).status, 429);
      assert.equal((await call('GET', '/api/admin/users', { token })).status, 200);
    } finally {
      LIMITS.userWrites.limit = saved;
    }
  });

  test('credential-less requests are limited per IP', async () => {
    const saved = LIMITS.anonymousPerIp.limit;
    LIMITS.anonymousPerIp.limit = 3;
    try {
      for (let i = 0; i < 3; i++) assert.equal((await call('GET', '/api/me')).status, 401);
      assert.equal((await call('GET', '/api/me')).status, 429);
    } finally {
      LIMITS.anonymousPerIp.limit = saved;
    }
  });

  test('client IP: proxy headers only behind a trusted proxy; IPv6 grouped by /64', () => {
    const req = { headers: { 'x-forwarded-for': '6.6.6.6' }, socket: { remoteAddress: '::ffff:10.0.0.7' } };
    assert.equal(clientIp(req), '10.0.0.7', 'spoofable header ignored off Vercel');
    process.env.TRUST_PROXY = '1';
    try {
      assert.equal(clientIp(req), '6.6.6.6');
    } finally {
      delete process.env.TRUST_PROXY;
    }
    assert.equal(normaliseIp('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
    assert.equal(normaliseIp('2001:db8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
    assert.equal(normaliseIp('::1'), '0:0:0:0::/64');
  });
});

describe('revoking access', () => {
  async function setup() {
    await insertAdmin();
    const adminToken = await tokenFor('auth-admin', 'admin@fast.test');
    const studentToken = await tokenFor('auth-s', 's@fast.test');
    const me = (await call('GET', '/api/me', { token: studentToken })).body.user;
    await call('PATCH', `/api/admin/users/${me.id}`, { token: adminToken, body: { status: 'approved' } });
    return { adminToken, studentToken, me };
  }

  test('force sign-out: every existing token stops working, access is kept', async () => {
    const { adminToken, studentToken, me } = await setup();
    assert.equal((await call('GET', '/api/timetables', { token: studentToken })).status, 200);
    const r = await call('PATCH', `/api/admin/users/${me.id}`, { token: adminToken, body: { revokeSessions: true } });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.status, 'approved');
    assert.ok(r.body.user.sessionsRevokedAt);
    for (const path of ['/api/me', '/api/timetables']) {
      const res = await call('GET', path, { token: studentToken });
      assert.equal(res.status, 401, path);
      assert.equal(res.body.details.code, 'SESSION_REVOKED');
    }
    // Signing in again (a token issued after the revocation) works.
    await db.query(`UPDATE app_users SET sessions_revoked_at = now() - interval '10 seconds' WHERE id = $1`, [me.id]);
    assert.equal((await call('GET', '/api/timetables', { token: await tokenFor('auth-s', 's@fast.test') })).status, 200);
    const audit = (await db.query(`SELECT action FROM audit_log WHERE action = 'user.signout'`)).rows;
    assert.equal(audit.length, 1);
  });

  test('restoring access lets the person back in after a fresh sign-in', async () => {
    const { adminToken, me } = await setup();
    await call('PATCH', `/api/admin/users/${me.id}`, { token: adminToken, body: { status: 'disabled' } });
    const restored = await call('PATCH', `/api/admin/users/${me.id}`, { token: adminToken, body: { status: 'approved' } });
    assert.equal(restored.status, 200);
    await db.query(`UPDATE app_users SET sessions_revoked_at = now() - interval '10 seconds' WHERE id = $1`, [me.id]);
    assert.equal((await call('GET', '/api/timetables', { token: await tokenFor('auth-s', 's@fast.test') })).status, 200);
  });

  test('moving an approved user to pending or rejected also signs them out', async () => {
    for (const status of ['pending', 'rejected']) {
      await db.query('DELETE FROM app_users');
      const { adminToken, studentToken, me } = await setup();
      await call('PATCH', `/api/admin/users/${me.id}`, { token: adminToken, body: { status } });
      assert.equal((await call('GET', '/api/me', { token: studentToken })).status, 401, status);
    }
  });

  test('a revoked admin loses admin access immediately', async () => {
    await insertAdmin('a1@fast.test', 'auth-a1');
    const a2 = await insertAdmin('a2@fast.test', 'auth-a2');
    const t1 = await tokenFor('auth-a1', 'a1@fast.test');
    const t2 = await tokenFor('auth-a2', 'a2@fast.test');
    assert.equal((await call('PATCH', `/api/admin/users/${a2.id}`, { token: t1, body: { status: 'disabled' } })).status, 200);
    assert.equal((await call('GET', '/api/admin/users', { token: t2 })).status, 401);
    assert.equal((await call('GET', '/api/admin/stats', { token: t2 })).status, 401);
  });

  test('an admin cannot revoke their own access; bad revokeSessions -> 422', async () => {
    const a1 = await insertAdmin('a1@fast.test', 'auth-a1');
    await insertAdmin('a2@fast.test', 'auth-a2');
    const t1 = await tokenFor('auth-a1', 'a1@fast.test');
    const r = await call('PATCH', `/api/admin/users/${a1.id}`, { token: t1, body: { status: 'disabled' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.details.code, 'SELF_LOCKOUT');
    assert.equal((await call('PATCH', `/api/admin/users/${a1.id}`, { token: t1, body: { revokeSessions: 'yes' } })).status, 422);
  });

  test('a student cannot revoke anyone', async () => {
    const { studentToken, me } = await setup();
    const r = await call('PATCH', `/api/admin/users/${me.id}`, { token: studentToken, body: { revokeSessions: true } });
    assert.equal(r.status, 403);
  });
});

describe('request bodies', () => {
  test('JSON that is not an object is refused with 400, not a crash', async () => {
    await insertAdmin();
    const token = await tokenFor('auth-admin', 'admin@fast.test');
    for (const raw of ['null', '[]', '"x"', '42', '{bad']) {
      const res = await fetch(base + '/api/admin/users', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: raw,
      });
      assert.equal(res.status, 400, raw);
    }
    const reset = await fetch(base + '/api/auth/password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    assert.equal(reset.status, 400);
  });
});

describe('dev server routing', () => {
  test('resolves static and dynamic routes like Vercel', () => {
    const rel = (hit) => hit && hit.file.replace(/\\/g, '/').split('/api/')[1];
    assert.equal(rel(resolveRoute(['me'])), 'me.js');
    assert.equal(rel(resolveRoute(['admin', 'users'])), 'admin/users.js');
    const dyn = resolveRoute(['admin', 'users', 'abc']);
    assert.equal(rel(dyn), 'admin/users/[id].js');
    assert.deepEqual(dyn.params, { id: 'abc' });
    assert.equal(resolveRoute(['nope']), null);
    assert.equal(resolveRoute(['..', 'package.json']), null);
  });

  test('unknown API path -> 404 JSON', async () => {
    const r = await call('GET', '/api/does-not-exist');
    assert.equal(r.status, 404);
  });
});
