// In-memory Postgres (PGlite) with every migration applied, adapted to the
// {query, tx, end} driver shape of server/db.js. Generic: other test files can
// reuse it.
//
//   const db = await createTestDb();
//   setDbDriver(db);          // from server/db.js
//   ...
//   await db.end();
//
// Options: { migrate: false } to skip migrations, { dir } for another folder.

import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { runMigrations } from '../../scripts/migrate.mjs';

function adapt(pg) {
  async function run(target, text, params) {
    if (params && params.length) {
      const res = await target.query(text, params);
      return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
    }
    // No params: allow multi-statement scripts (migrations), like node-postgres.
    const results = await target.exec(text);
    const last = results[results.length - 1] || { rows: [] };
    return { rows: last.rows, rowCount: last.affectedRows ?? last.rows.length };
  }

  let chain = Promise.resolve();
  return {
    pg,
    query: (text, params) => run(pg, text, params),
    // Serialise transactions: PGlite is a single connection.
    tx(fn) {
      const next = chain.then(() =>
        pg.transaction(async (t) => fn({ query: (text, params) => run(t, text, params) })),
      );
      chain = next.catch(() => {});
      return next;
    },
    end: () => pg.close(),
  };
}

export async function createTestDb({ migrate = true, dir } = {}) {
  const pg = new PGlite({ extensions: { citext } });
  await pg.waitReady;
  const db = adapt(pg);
  if (migrate) await runMigrations(db, dir ? { dir } : {});
  return db;
}
