import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from '../scripts/load-env.mjs';
import { normalise, parseUsersFile, seedUsers } from '../scripts/seed-users.mjs';
import { listMigrations, runMigrations } from '../scripts/migrate.mjs';
import { createTestDb } from './helpers/pglite-db.js';

let db;
before(async () => {
  db = await createTestDb();
});
after(() => db.end());

test('migrations are tracked and re-running applies nothing', async () => {
  const names = (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
  assert.deepEqual(names, listMigrations());
  assert.ok(names.includes('001_app_users.sql'));
  assert.deepEqual(await runMigrations(db), []);
});

test('app_users constraints', async () => {
  await assert.rejects(db.query(`INSERT INTO app_users (email, role) VALUES ('r@x.co', 'root')`));
  await assert.rejects(db.query(`INSERT INTO app_users (email, status) VALUES ('s@x.co', 'maybe')`));
  await assert.rejects(db.query(`INSERT INTO app_users (email, source) VALUES ('t@x.co', 'magic')`));
  await db.query(`INSERT INTO app_users (email) VALUES ('Case@X.co')`);
  await assert.rejects(db.query(`INSERT INTO app_users (email) VALUES ('case@x.CO')`), /unique|duplicate/i);
});

test('parses CSV (with and without header, quotes) and JSON', () => {
  const csv = 'email,displayName,role\nA@x.co,"Last, First",admin\nb@x.co,Bee,\n# comment\n';
  assert.deepEqual(parseUsersFile(csv, 'u.csv'), [
    { email: 'A@x.co', displayName: 'Last, First', role: 'admin' },
    { email: 'b@x.co', displayName: 'Bee', role: undefined },
  ]);
  assert.equal(parseUsersFile('c@x.co,Cee,student', 'u.csv').length, 1);
  assert.deepEqual(parseUsersFile('[{"email":"d@x.co","name":"Dee"}]', 'u.json'), [{ email: 'd@x.co', displayName: 'Dee', role: undefined }]);
  const { users, errors } = normalise([{ email: 'bad' }, { email: 'E@x.co', role: 'boss' }, { email: 'e@x.co' }, { email: 'E@X.co', displayName: 'Eee' }]);
  assert.equal(errors.length, 2);
  assert.deepEqual(users, [{ email: 'e@x.co', displayName: 'Eee', role: undefined }]);
});

test('seed is idempotent, never downgrades, and promotes ADMIN_EMAILS', async () => {
  await db.query(`DELETE FROM app_users`);
  await db.query(`INSERT INTO app_users (email, status, source, auth_user_id) VALUES ('pend@x.co', 'pending', 'signup', 'a1')`);
  await db.query(`INSERT INTO app_users (email, status, source) VALUES ('dis@x.co', 'disabled', 'signup')`);

  const users = normalise([
    { email: 'new@x.co', displayName: 'New' },
    { email: 'pend@x.co', displayName: 'Pend' },
    { email: 'dis@x.co' },
  ]).users;
  const first = await seedUsers(db, users, ['boss@x.co']);
  assert.deepEqual(first, { created: 2, updated: 1, unchanged: 1 });
  const second = await seedUsers(db, users, ['boss@x.co']);
  assert.deepEqual(second, { created: 0, updated: 0, unchanged: 4 });

  const rows = Object.fromEntries((await db.query('SELECT * FROM app_users')).rows.map((r) => [r.email, r]));
  assert.equal(rows['new@x.co'].status, 'approved');
  assert.equal(rows['new@x.co'].source, 'preadded');
  assert.equal(rows['pend@x.co'].status, 'approved');
  assert.equal(rows['pend@x.co'].source, 'signup', 'source is kept');
  assert.equal(rows['dis@x.co'].status, 'disabled', 'disabled stays disabled');
  assert.equal(rows['boss@x.co'].role, 'admin');
  assert.equal(rows['boss@x.co'].status, 'approved');

  // ADMIN_EMAILS force-approves even a disabled account.
  await seedUsers(db, [], ['dis@x.co']);
  const dis = (await db.query(`SELECT role, status FROM app_users WHERE email = 'dis@x.co'`)).rows[0];
  assert.deepEqual(dis, { role: 'admin', status: 'approved' });
});

test('env file parser', () => {
  assert.deepEqual(
    parseEnv('# c\nA=1\nexport B="two words"\nC=\'x#y\'\nD=val # trailing\n\nBAD LINE\nE=postgres://u:p@h/db?sslmode=require\n'),
    { A: '1', B: 'two words', C: 'x#y', D: 'val', E: 'postgres://u:p@h/db?sslmode=require' },
  );
});
