// Handler logic for /api/schedules/:timetableId (see api/timetables/_lib.js for
// why this lives in an underscore file).

import { query } from '../../server/db.js';
import { HttpError, param, sendJson } from '../../server/http.js';
import { getVisibleTimetable, jsonBody } from '../timetables/_lib.js';

export const MAX_SECTION_KEYS = 200;
export const MAX_KEY_LENGTH = 120;
export const MAX_COLOR_ENTRIES = 200;
export const MAX_COLOR_KEY_LENGTH = 200;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

/** Returns { sectionKeys, colorAssignments } or throws a 422. Pure; no DB access. */
export function validateScheduleBody(body) {
  if (!isPlainObject(body)) throw new HttpError(422, 'Expected a JSON object');

  const keys = body.sectionKeys;
  if (!Array.isArray(keys)) throw new HttpError(422, 'sectionKeys must be an array of strings');
  if (keys.length > MAX_SECTION_KEYS) {
    throw new HttpError(422, `sectionKeys can hold at most ${MAX_SECTION_KEYS} entries`);
  }
  const sectionKeys = [];
  const seen = new Set();
  for (const k of keys) {
    if (typeof k !== 'string' || !k || k.length > MAX_KEY_LENGTH) {
      throw new HttpError(422, `Each section key must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`);
    }
    if (!seen.has(k)) {
      seen.add(k);
      sectionKeys.push(k);
    }
  }

  const colors = body.colorAssignments === undefined ? {} : body.colorAssignments;
  if (!isPlainObject(colors)) throw new HttpError(422, 'colorAssignments must be an object');
  const entries = Object.entries(colors);
  if (entries.length > MAX_COLOR_ENTRIES) {
    throw new HttpError(422, `colorAssignments can hold at most ${MAX_COLOR_ENTRIES} entries`);
  }
  const colorAssignments = {};
  for (const [k, v] of entries) {
    const okValue = (Number.isInteger(v) && v >= 0 && v <= 100000) || (typeof v === 'string' && v.length <= 32);
    if (!k || k.length > MAX_COLOR_KEY_LENGTH || !okValue) {
      throw new HttpError(422, 'colorAssignments must map names to small non-negative integers (or short strings)');
    }
    colorAssignments[k] = v;
  }

  return { sectionKeys, colorAssignments };
}

function scheduleDto(row) {
  return {
    sectionKeys: row.section_keys,
    colorAssignments: row.color_assignments,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

export function createScheduleHandlers({ requireApprovedUser }) {
  return {
    async GET(req, res) {
      const user = await requireApprovedUser(req);
      const timetable = await getVisibleTimetable(param(req, 'timetableId'), user, 'id, is_published');
      const { rows } = await query(
        `SELECT section_keys, color_assignments, updated_at
         FROM saved_schedules WHERE user_id = $1 AND timetable_id = $2`,
        [user.id, timetable.id]
      );
      sendJson(res, 200, { schedule: rows[0] ? scheduleDto(rows[0]) : null });
    },

    async PUT(req, res) {
      const user = await requireApprovedUser(req);
      const timetable = await getVisibleTimetable(param(req, 'timetableId'), user, 'id, is_published');
      const { sectionKeys, colorAssignments } = validateScheduleBody(await jsonBody(req));

      if (sectionKeys.length) {
        const known = await query(
          `SELECT code || '|' || section AS key FROM sections
           WHERE timetable_id = $1 AND code || '|' || section = ANY($2::text[])`,
          [timetable.id, sectionKeys]
        );
        const have = new Set(known.rows.map((r) => r.key));
        const unknown = sectionKeys.filter((k) => !have.has(k));
        if (unknown.length) {
          throw new HttpError(422, 'Some sections are not part of this timetable', {
            unknownKeys: unknown.slice(0, 20),
          });
        }
      }

      let row;
      try {
        const res2 = await query(
          `INSERT INTO saved_schedules (user_id, timetable_id, section_keys, color_assignments, updated_at)
           VALUES ($1, $2, $3::text[], $4::jsonb, now())
           ON CONFLICT (user_id, timetable_id) DO UPDATE
             SET section_keys = EXCLUDED.section_keys,
                 color_assignments = EXCLUDED.color_assignments,
                 updated_at = now()
           RETURNING section_keys, color_assignments, updated_at`,
          [user.id, timetable.id, sectionKeys, JSON.stringify(colorAssignments)]
        );
        row = res2.rows[0];
      } catch (err) {
        // The timetable was deleted between the check above and the insert.
        if (err && err.code === '23503') throw new HttpError(404, 'Timetable not found');
        throw err;
      }
      sendJson(res, 200, { schedule: scheduleDto(row) });
    },
  };
}
