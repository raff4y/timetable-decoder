// Apply db/migrations/*.sql in filename order, each inside its own transaction,
// recording them in schema_migrations. Safe to run repeatedly.
//
//   npm run migrate            (reads DATABASE_URL from env or .env.local)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, ROOT } from './load-env.mjs';

export const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations');

export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
}

/**
 * @param {{query: Function, tx: Function}} db  driver shape from server/db.js
 * @returns {Promise<string[]>} names applied by this run
 */
export async function runMigrations(db, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied = [];
  for (const name of listMigrations(dir)) {
    if (done.has(name)) continue;
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    await db.tx(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
    log(`applied ${name}`);
    applied.push(name);
  }
  return applied;
}

async function main() {
  loadEnv();
  const { query, tx, closeDb } = await import('../server/db.js');
  try {
    const applied = await runMigrations({ query, tx }, { log: (m) => console.log(m) });
    console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : 'Up to date.');
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
