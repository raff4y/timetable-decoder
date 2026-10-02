// Database access shared by every /api function and script.
//
//   query(text, params)  -> { rows, rowCount }
//   tx(async (client) => { await client.query(text, params); ... })
//
// Neon hosts go over Neon's serverless driver (HTTP for single queries, a
// short-lived WebSocket Pool for transactions); any other URL is treated as a
// plain Postgres server and goes through `pg`. Tests swap the whole driver
// out for an in-process PGlite instance with setDbDriver().

import pg from 'pg';
import { neon, Pool as NeonPool } from '@neondatabase/serverless';

let driver = null;

function isNeonUrl(url) {
  try {
    return /\.neon\.(tech|build)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function neonDriver(url) {
  const sql = neon(url, { fullResults: true });
  return {
    async query(text, params = []) {
      const res = await sql.query(text, params);
      return { rows: res.rows, rowCount: res.rowCount };
    },
    async tx(fn) {
      const pool = new NeonPool({ connectionString: url });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
        await pool.end();
      }
    },
    async end() {},
  };
}

function pgDriver(url) {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return {
    query: (text, params = []) => pool.query(text, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

function getDriver() {
  if (driver) return driver;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  driver = isNeonUrl(url) ? neonDriver(url) : pgDriver(url);
  return driver;
}

/** Tests only: replace the driver (object with query/tx/end). Pass null to reset. */
export function setDbDriver(next) {
  driver = next;
}

export function query(text, params) {
  return getDriver().query(text, params);
}

export function tx(fn) {
  return getDriver().tx(fn);
}

export async function closeDb() {
  if (driver) await driver.end();
  driver = null;
}
