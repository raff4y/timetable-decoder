// src/auth-client.js against a fake Neon Auth SDK client and the real API
// handlers (via the dev server) with a local JWKS.

import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { setDbDriver } from '../server/db.js';
import { resetRateLimitMemory } from '../server/rate-limit.js';
import { createApiServer } from '../scripts/dev-server.mjs';
import { createTestDb } from './helpers/pglite-db.js';
import { startAuthEnv } from './helpers/auth-env.js';

let db;
let env;
let server;
let base;
let client;
const realFetch = globalThis.fetch;
let redirects;

globalThis.location = {
  origin: 'http://app.test',
  pathname: '/app.html',
  search: '?x=1',
  replace: (u) => redirects.push(u),
};
const auth = await import('../src/auth-client.js');

function fakeClient({ email = 'stu@fast.test', verified = true, signUpError, signInError, resetError } = {}) {
  const state = { sub: null, calls: [] };
  return {
    state,
    signUp: {
      email: async (args) => {
        state.calls.push(['signUp', args]);
        if (signUpError) return { data: null, error: signUpError };
        if (verified) state.sub = 'auth-' + args.email;
        return { data: { user: { email: args.email } }, error: null };
      },
    },
    signIn: {
      email: async (args) => {
        state.calls.push(['signIn', args]);
        if (signInError) return { data: null, error: signInError };
        state.sub = 'auth-' + args.email;
        return { data: {}, error: null };
      },
    },
    signOut: async () => {
      state.sub = null;
      state.calls.push(['signOut']);
    },
    token: async () => {
      if (!state.sub) return { data: null, error: { status: 401 } };
      return { data: { token: await env.sign({ sub: state.sub, email: state.sub.replace('auth-', ''), emailVerified: true }) }, error: null };
    },
    resetPassword: async (args) => {
      state.calls.push(['resetPassword', args]);
      return resetError ? { data: null, error: resetError } : { data: {}, error: null };
    },
  };
}

before(async () => {
  env = await startAuthEnv();
  db = await createTestDb();
  setDbDriver(db);
  server = createApiServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // Browser-relative '/api/...' URLs go to the test server.
  globalThis.fetch = (url, init) => realFetch(typeof url === 'string' && url.startsWith('/') ? base + url : url, init);
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((r) => server.close(r));
  await env.stop();
  setDbDriver(null);
  await db.end();
});

beforeEach(async () => {
  resetRateLimitMemory();
  redirects = [];
  await db.query('DELETE FROM app_users');
  await db.query('DELETE FROM auth_rate_limits');
  client = fakeClient();
  auth.__setAuthClientForTests(client);
});

test('signUp: validates locally, then returns the /api/me user (pending)', async () => {
  assert.equal((await auth.signUp({ name: 'A', email: 'nope', password: 'longenough' })).error.code, 'INVALID_EMAIL');
  assert.equal((await auth.signUp({ name: 'A', email: 'a@fast.test', password: 'short' })).error.code, 'WEAK_PASSWORD');
  assert.equal(client.state.calls.length, 0, 'invalid input never reaches Neon');

  const r = await auth.signUp({ name: 'Stu', email: 'stu@fast.test', password: 'longenough' });
  assert.equal(r.ok, true);
  assert.equal(r.needsVerification, undefined);
  assert.equal(r.user.status, 'pending');
  assert.equal(r.user.email, 'stu@fast.test');
});

test('signUp for a pre-added email returns an approved user', async () => {
  await db.query(`INSERT INTO app_users (email, status, source, approved_at) VALUES ('stu@fast.test', 'approved', 'preadded', now())`);
  const r = await auth.signUp({ name: 'Stu', email: 'stu@fast.test', password: 'longenough' });
  assert.equal(r.user.status, 'approved');
  assert.equal(r.user.source, 'preadded');
});

test('signUp when verification is required: ok + needsVerification and a provisional pending user', async () => {
  auth.__setAuthClientForTests(fakeClient({ verified: false }));
  const r = await auth.signUp({ name: 'Stu', email: 'Stu@fast.test', password: 'longenough' });
  assert.equal(r.ok, true);
  assert.equal(r.needsVerification, true);
  assert.equal(r.user.status, 'pending');
  assert.equal(r.user.email, 'stu@fast.test');
});

test('signUp / signIn error mapping', async () => {
  auth.__setAuthClientForTests(fakeClient({ signUpError: { status: 422, code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', message: 'x' } }));
  assert.equal((await auth.signUp({ name: 'A', email: 'a@fast.test', password: 'longenough' })).error.code, 'EMAIL_TAKEN');
  auth.__setAuthClientForTests(fakeClient({ signUpError: { status: 400, code: 'PASSWORD_TOO_SHORT', message: 'x' } }));
  assert.equal((await auth.signUp({ name: 'A', email: 'a@fast.test', password: 'longenough' })).error.code, 'WEAK_PASSWORD');
  auth.__setAuthClientForTests(fakeClient({ signInError: { status: 401, code: 'INVALID_EMAIL_OR_PASSWORD', message: 'x' } }));
  const bad = await auth.signIn({ email: 'a@fast.test', password: 'wrongwrong' });
  assert.deepEqual([bad.ok, bad.error.code], [false, 'INVALID_CREDENTIALS']);
  assert.ok(bad.error.message.length > 5);
  auth.__setAuthClientForTests(fakeClient({ signInError: { status: 403, code: 'EMAIL_NOT_VERIFIED', message: 'x' } }));
  assert.equal((await auth.signIn({ email: 'a@fast.test', password: 'wrongwrong' })).error.code, 'EMAIL_NOT_VERIFIED');
  auth.__setAuthClientForTests(fakeClient({ signInError: { status: 429, message: 'slow down' } }));
  assert.equal((await auth.signIn({ email: 'a@fast.test', password: 'wrongwrong' })).error.code, 'RATE_LIMITED');
  assert.equal(auth.mapAuthError({ message: 'Failed to fetch' }).error.code, 'NETWORK');
});

test('signIn returns the user; getCurrentUser works; signOut clears it', async () => {
  const r = await auth.signIn({ email: 'stu@fast.test', password: 'longenough' });
  assert.equal(r.ok, true);
  assert.equal(r.user.email, 'stu@fast.test');
  assert.equal((await auth.getCurrentUser()).email, 'stu@fast.test');
  assert.deepEqual(await auth.signOut(), { ok: true });
  assert.equal(await auth.getCurrentUser(), null);
});

test('apiFetch: attaches auth, adds /api prefix, JSON in/out, error shape', async () => {
  await auth.signIn({ email: 'stu@fast.test', password: 'longenough' });
  const ok = await auth.apiFetch('/me');
  assert.equal(ok.ok, true);
  assert.equal(ok.data.user.email, 'stu@fast.test');
  assert.equal((await auth.apiFetch('/api/me')).ok, true);

  const denied = await auth.apiFetch('/admin/users', { method: 'POST', body: { email: 'x@y.co' } });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.error.code, 'NOT_APPROVED');

  await auth.signOut();
  const anon = await auth.apiFetch('/me');
  assert.equal(anon.status, 401);
  assert.equal(anon.error.code, 'UNAUTHENTICATED');
});

test('revoked by an admin: the next API call signs the browser out and goes to the login page', async () => {
  await auth.signIn({ email: 'stu@fast.test', password: 'longenough' });
  await db.query(`UPDATE app_users SET status = 'approved'`);
  assert.equal((await auth.apiFetch('/timetables')).ok, true);
  // Revoke "now" (a little ahead, so tokens minted in this second are covered too).
  await db.query(`UPDATE app_users SET sessions_revoked_at = now() + interval '1 minute'`);
  const res = await auth.apiFetch('/timetables');
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'SESSION_REVOKED');
  assert.deepEqual(redirects, ['/login.html?reason=revoked']);
  assert.ok(client.state.calls.some(([name]) => name === 'signOut'), 'Neon session ended');
  assert.equal(client.state.sub, null);
});

test('signIn to a revoked account fails with ACCOUNT_REVOKED and leaves no session behind', async () => {
  await auth.signIn({ email: 'stu@fast.test', password: 'longenough' });
  await db.query(`UPDATE app_users SET status = 'disabled'`);
  await auth.signOut();
  const r = await auth.signIn({ email: 'stu@fast.test', password: 'longenough' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ACCOUNT_REVOKED');
  assert.equal(client.state.sub, null);
  assert.deepEqual(redirects, [], 'the login page shows the message; no redirect');
});

test('requestPasswordReset goes through our endpoint, is generic, and never calls Neon directly', async () => {
  assert.equal((await auth.requestPasswordReset({ email: 'bad' })).error.code, 'INVALID_EMAIL');
  const r = await auth.requestPasswordReset({ email: 'someone@fast.test' });
  assert.deepEqual(r, { ok: true });
  assert.equal(client.state.calls.filter((c) => c[0].startsWith('request')).length, 0);
  assert.equal(env.resetCalls.length, 1, 'our server relayed it');
  // app.test is not this server's origin, so the server substitutes its own login page.
  assert.equal(env.resetCalls[0].body.redirectTo, `${base}/login.html?view=reset`);
  // Pre-added: still { ok: true }, nothing sent.
  await db.query(`INSERT INTO app_users (email, status, source) VALUES ('pre@fast.test', 'approved', 'preadded')`);
  assert.deepEqual(await auth.requestPasswordReset({ email: 'pre@fast.test' }), { ok: true });
  assert.equal(env.resetCalls.length, 1);
});

test('resetPassword', async () => {
  assert.equal((await auth.resetPassword({ token: '', newPassword: 'longenough' })).error.code, 'RESET_TOKEN_INVALID');
  assert.equal((await auth.resetPassword({ token: 't', newPassword: 'short' })).error.code, 'WEAK_PASSWORD');
  assert.deepEqual(await auth.resetPassword({ token: 't', newPassword: 'longenough' }), { ok: true });
  assert.deepEqual(client.state.calls.at(-1), ['resetPassword', { newPassword: 'longenough', token: 't' }]);
  auth.__setAuthClientForTests(fakeClient({ resetError: { status: 400, code: 'INVALID_TOKEN', message: 'Invalid token' } }));
  assert.equal((await auth.resetPassword({ token: 'old', newPassword: 'longenough' })).error.code, 'RESET_TOKEN_INVALID');
});

test('requireUser redirects as the contract says', async () => {
  // not signed in
  assert.equal(await auth.requireUser(), null);
  assert.deepEqual(redirects, ['/login.html?next=%2Fapp.html%3Fx%3D1']);

  // pending
  redirects = [];
  await auth.signUp({ name: 'Stu', email: 'stu@fast.test', password: 'longenough' });
  assert.equal(await auth.requireUser(), null);
  assert.deepEqual(redirects, ['/pending.html']);
  redirects = [];
  assert.equal((await auth.requireUser({ allowPending: true })).status, 'pending');
  assert.deepEqual(redirects, []);

  // approved student, admin page
  await db.query(`UPDATE app_users SET status = 'approved'`);
  assert.equal((await auth.requireUser()).status, 'approved');
  assert.equal(await auth.requireUser({ role: 'admin' }), null);
  assert.deepEqual(redirects, ['/app.html']);

  // admin
  redirects = [];
  await db.query(`UPDATE app_users SET role = 'admin'`);
  assert.equal((await auth.requireUser({ role: 'admin' })).role, 'admin');
  assert.deepEqual(redirects, []);
});

test('safeNext only allows same-origin paths; postSignInDestination', () => {
  const ok = ['/app.html', '/app.html?x=1#y', '/admin.html'];
  for (const n of ok) assert.equal(auth.safeNext(n), n);
  for (const n of ['//evil.com', 'http://evil.com', 'https://app.test/x', '/\\evil.com', 'javascript:alert(1)', '', null, undefined, 'app.html']) {
    assert.equal(auth.safeNext(n), null, String(n));
  }
  assert.equal(auth.postSignInDestination({ status: 'approved' }, '?next=%2Fadmin.html'), '/admin.html');
  assert.equal(auth.postSignInDestination({ status: 'approved' }, '?next=%2F%2Fevil.com'), '/app.html');
  assert.equal(auth.postSignInDestination({ status: 'approved' }, ''), '/app.html');
  assert.equal(auth.postSignInDestination({ status: 'pending' }, '?next=%2Fapp.html'), '/pending.html');
});
