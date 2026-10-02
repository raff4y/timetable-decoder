// Pre-add accounts and promote admins. Idempotent: safe to re-run.
//
//   npm run seed:users -- users.csv            (or users.json)
//   npm run seed:users                         (only promotes ADMIN_EMAILS)
//   npm run seed:users -- users.csv --dry-run
//
// File formats
//   CSV:  email,displayName,role        (header row optional; role optional, default student)
//   JSON: [{ "email": "...", "displayName": "...", "role": "student" }, ...]
//
// What it does: each person becomes an `app_users` row with source='preadded',
// status='approved' and no auth user yet. Neon Auth has no server-side "create
// user with password / invite" call (its create-user API takes only email+name),
// so these people open the sign-up page, register with THAT email, verify it, and
// the verified sign-in links them to the pre-approved row (server/auth.js).
//
// Existing rows are never downgraded: a pending sign-up becomes approved, an
// existing row keeps its source/status (rejected/disabled stay as they are) and
// only gets a role/name change if one is given. ADMIN_EMAILS (comma list in env)
// are created or promoted to APPROVED admins, even if they were rejected/disabled.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './load-env.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['student', 'admin'];

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseUsersFile(text, filename = '') {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (!trimmed) return [];
  if (filename.toLowerCase().endsWith('.json') || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const data = JSON.parse(trimmed);
    const list = Array.isArray(data) ? data : data.users;
    if (!Array.isArray(list)) throw new Error('JSON must be an array of users (or { "users": [...] })');
    return list.map((u) => ({ email: u.email, displayName: u.displayName ?? u.name ?? '', role: u.role }));
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const rows = lines.map(parseCsvLine);
  if (rows.length && /^email$/i.test(rows[0][0])) rows.shift();
  return rows.map(([email, displayName, role]) => ({ email, displayName: displayName ?? '', role: role || undefined }));
}

export function normalise(users) {
  const seen = new Map();
  const errors = [];
  users.forEach((u, i) => {
    const email = String(u.email ?? '').trim().toLowerCase();
    const role = u.role ? String(u.role).trim().toLowerCase() : undefined;
    if (!EMAIL_RE.test(email)) return errors.push(`entry ${i + 1}: invalid email "${u.email}"`);
    if (role && !ROLES.includes(role)) return errors.push(`entry ${i + 1} (${email}): role must be student or admin`);
    seen.set(email, { email, displayName: String(u.displayName ?? '').trim(), role });
  });
  return { users: [...seen.values()], errors };
}

/** Apply to the database. Returns counts. */
export async function seedUsers(db, users, adminEmails = []) {
  const stats = { created: 0, updated: 0, unchanged: 0 };
  const byEmail = new Map(users.map((u) => [u.email, { ...u }]));
  for (const raw of adminEmails) {
    const email = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error(`ADMIN_EMAILS contains an invalid email: "${raw}"`);
    byEmail.set(email, { ...(byEmail.get(email) || { email, displayName: '' }), role: 'admin', forceApprove: true });
  }
  for (const u of byEmail.values()) {
    await db.tx(async (c) => {
      const found = (await c.query('SELECT * FROM app_users WHERE email = $1 FOR UPDATE', [u.email])).rows[0];
      if (!found) {
        await c.query(
          `INSERT INTO app_users (email, display_name, role, status, source, approved_at)
           VALUES ($1, $2, $3, 'approved', 'preadded', now())`,
          [u.email, u.displayName, u.role || 'student'],
        );
        stats.created++;
        return;
      }
      const nextRole = u.role || found.role;
      const nextName = found.display_name || u.displayName;
      const nextStatus = found.status === 'pending' || u.forceApprove ? 'approved' : found.status;
      const changed = nextRole !== found.role || nextName !== found.display_name || nextStatus !== found.status;
      if (!changed) {
        stats.unchanged++;
        return;
      }
      await c.query(
        `UPDATE app_users SET role = $2, display_name = $3, status = $4,
                approved_at = CASE WHEN $4 = 'approved' AND approved_at IS NULL THEN now() ELSE approved_at END
          WHERE id = $1`,
        [found.id, nextRole, nextName, nextStatus],
      );
      stats.updated++;
    });
  }
  return stats;
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));

  let users = [];
  if (file) {
    const text = fs.readFileSync(path.resolve(file), 'utf8');
    const { users: list, errors } = normalise(parseUsersFile(text, file));
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exit(1);
    }
    users = list;
  }
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!users.length && !adminEmails.length) {
    console.error('Nothing to do: pass a .csv/.json file and/or set ADMIN_EMAILS.');
    process.exit(1);
  }
  console.log(`${users.length} user(s) from file, ${adminEmails.length} admin email(s) from ADMIN_EMAILS.`);
  if (dryRun) {
    for (const u of users) console.log(`  would add ${u.email} (${u.role || 'student'})`);
    for (const e of adminEmails) console.log(`  would make admin ${e}`);
    return;
  }
  const { query, tx, closeDb } = await import('../server/db.js');
  try {
    const stats = await seedUsers({ query, tx }, users, adminEmails);
    console.log(`Done: ${stats.created} created, ${stats.updated} updated, ${stats.unchanged} unchanged.`);
    console.log('People now sign up on the site with these emails and verify them to activate the accounts.');
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
