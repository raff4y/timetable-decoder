// Handler logic for /api/timetables. Files starting with "_" are not deployed as
// functions by Vercel; index.js and [id].js wire these to the real auth module,
// and tests inject fake auth here.

import crypto from 'node:crypto';
import { query, tx } from '../../server/db.js';
import { HttpError, param, readBody, readJson, sendJson } from '../../server/http.js';
import { parseWorkbook, TimetableParseError, meetingIsLab } from '../../server/parser/index.js';
import { recordAudit } from '../../server/activity.js';
import { enforce, rule } from '../../server/rate-limit.js';

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // Vercel caps request bodies at 4.5 MB
const MAX_FIELD = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

const LIST_COLUMNS = `id, department, semester, title, template, section_count, is_published,
  explicit_durations, file_name, created_at`;

export function timetableDto(row, extra = {}) {
  return {
    id: row.id,
    department: row.department,
    semester: row.semester,
    title: row.title,
    template: row.template,
    sectionCount: row.section_count,
    isPublished: row.is_published,
    explicitDurations: row.explicit_durations,
    fileName: row.file_name,
    uploadedAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    ...extra,
  };
}

/** Fetch a timetable row the caller may see (students: published only), or throw 404. */
export async function getVisibleTimetable(id, user, columns = LIST_COLUMNS) {
  if (!isUuid(id)) throw new HttpError(404, 'Timetable not found');
  const { rows } = await query(`SELECT ${columns} FROM timetables WHERE id = $1`, [id]);
  const row = rows[0];
  if (!row || (!row.is_published && user.role !== 'admin')) {
    throw new HttpError(404, 'Timetable not found');
  }
  return row;
}

/**
 * JSON request body. Vercel pre-parses JSON into req.body (and consumes the
 * stream); under the plain node:http dev server the stream is still readable.
 */
export async function jsonBody(req) {
  const b = req.body;
  if (b !== undefined && b !== null && !Buffer.isBuffer(b)) {
    if (typeof b === 'string') {
      try {
        return JSON.parse(b);
      } catch {
        throw new HttpError(400, 'Invalid JSON body');
      }
    }
    if (typeof b === 'object') return b;
  }
  return readJson(req);
}

function cleanText(value, field, { required = false } = {}) {
  if (typeof value !== 'string') throw new HttpError(422, `${field} must be a string`);
  const v = value.trim();
  if (required && !v) throw new HttpError(422, `${field} cannot be empty`);
  if (v.length > MAX_FIELD) throw new HttpError(422, `${field} is too long (max ${MAX_FIELD} characters)`);
  return v;
}

function headerValue(req, name) {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

function uploadFileName(req) {
  const raw = headerValue(req, 'x-filename');
  if (!raw) return '';
  let name = String(raw);
  try {
    name = decodeURIComponent(name);
  } catch {
    // not percent-encoded; use as sent
  }
  return name.replace(/[\u0000-\u001f]/g, '').slice(0, 255);
}

/** Insert sections + meetings with one multi-row INSERT (unnest) per table. */
async function insertSections(client, timetableId, sections) {
  const sec = {
    position: [], code: [], name: [], section: [], teacher: [], batch: [], nameIsLab: [],
  };
  sections.forEach((s, i) => {
    sec.position.push(i);
    sec.code.push(s.code);
    sec.name.push(s.name);
    sec.section.push(s.section);
    sec.teacher.push(s.teacher);
    sec.batch.push(s.batch);
    sec.nameIsLab.push(Boolean(s.nameIsLab));
  });

  const inserted = await client.query(
    `INSERT INTO sections (timetable_id, position, code, name, section, teacher, batch, name_is_lab)
     SELECT $1::uuid, t.position, t.code, t.name, t.section, t.teacher, t.batch, t.name_is_lab
     FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::boolean[])
       AS t(position, code, name, section, teacher, batch, name_is_lab)
     RETURNING id, position`,
    [timetableId, sec.position, sec.code, sec.name, sec.section, sec.teacher, sec.batch, sec.nameIsLab]
  );
  const idByPosition = new Map(inserted.rows.map((r) => [Number(r.position), r.id]));

  const m = { sectionId: [], position: [], dayIdx: [], startMin: [], rawTime: [], room: [], durMin: [], isLab: [] };
  sections.forEach((s, i) => {
    s.meetings.forEach((mt, j) => {
      m.sectionId.push(idByPosition.get(i));
      m.position.push(j);
      m.dayIdx.push(mt.dayIdx);
      m.startMin.push(mt.startMin);
      m.rawTime.push(mt.rawTime);
      m.room.push(mt.room);
      m.durMin.push(mt.durMin ?? null);
      m.isLab.push(meetingIsLab(s, mt));
    });
  });
  if (m.sectionId.length) {
    await client.query(
      `INSERT INTO meetings (section_id, position, day_idx, start_min, raw_time, room, dur_min, is_lab)
       SELECT * FROM unnest($1::bigint[], $2::int[], $3::smallint[], $4::int[], $5::text[], $6::text[], $7::int[], $8::boolean[])`,
      [m.sectionId, m.position, m.dayIdx, m.startMin, m.rawTime, m.room, m.durMin, m.isLab]
    );
  }
}

/** Sections in exactly the shape the browser parser used to produce. */
export async function loadSections(timetableId) {
  const [secRes, meetRes] = await Promise.all([
    query(
      `SELECT id, code, name, section, teacher, batch, name_is_lab
       FROM sections WHERE timetable_id = $1 ORDER BY position`,
      [timetableId]
    ),
    query(
      `SELECT m.section_id, m.day_idx, m.start_min, m.raw_time, m.room, m.dur_min, m.is_lab
       FROM meetings m JOIN sections s ON s.id = m.section_id
       WHERE s.timetable_id = $1
       ORDER BY s.position, m.position`,
      [timetableId]
    ),
  ]);

  const bySection = new Map();
  for (const r of meetRes.rows) {
    const key = String(r.section_id);
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push({
      dayIdx: r.day_idx,
      startMin: r.start_min,
      rawTime: r.raw_time,
      room: r.room,
      durMin: r.dur_min,
      isLab: r.is_lab,
    });
  }
  return secRes.rows.map((r) => ({
    code: r.code,
    name: r.name,
    section: r.section,
    teacher: r.teacher,
    batch: r.batch,
    nameIsLab: r.name_is_lab,
    meetings: bySection.get(String(r.id)) || [],
  }));
}

/**
 * @param {{ requireApprovedUser: Function, requireAdmin: Function }} auth
 */
export function createTimetableHandlers(auth) {
  const { requireApprovedUser, requireAdmin } = auth;

  return {
    index: {
      async GET(req, res) {
        const user = await requireApprovedUser(req);
        const sql = user.role === 'admin'
          ? `SELECT ${LIST_COLUMNS} FROM timetables ORDER BY created_at DESC`
          : `SELECT ${LIST_COLUMNS} FROM timetables WHERE is_published ORDER BY created_at DESC`;
        const { rows } = await query(sql);
        sendJson(res, 200, { timetables: rows.map((r) => timetableDto(r)) });
      },

      async POST(req, res) {
        const user = await requireAdmin(req);
        // Parsing a workbook is the most expensive thing the API does.
        await enforce([rule('uploads', user.id)], 'Too many uploads. Wait a few minutes and try again.');

        // Vercel pre-parses application/octet-stream into req.body and consumes the stream.
        const declared = Number(headerValue(req, 'content-length'));
        if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, 'File too large (max 4 MB)');
        const body = Buffer.isBuffer(req.body) ? req.body : await readBody(req, MAX_UPLOAD_BYTES);
        if (body.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'File too large (max 4 MB)');
        if (!body.length) throw new HttpError(422, 'The upload was empty');

        const fileName = uploadFileName(req);
        let parsed;
        try {
          parsed = parseWorkbook(body, fileName);
        } catch (err) {
          if (err instanceof TimetableParseError) throw new HttpError(422, err.message);
          console.error('Unexpected parser failure', err);
          throw new HttpError(422, 'Could not read that file as a timetable.');
        }

        const sha = crypto.createHash('sha256').update(body).digest('hex');
        const dup = await query('SELECT id, title FROM timetables WHERE file_sha256 = $1', [sha]);
        if (dup.rows[0]) {
          throw new HttpError(409, 'This exact file has already been uploaded', {
            existingId: dup.rows[0].id,
            existingTitle: dup.rows[0].title,
          });
        }

        const { meta, sections, warnings } = parsed;
        const explicit = sections.every((s) => s.meetings.every((m) => m.durMin));
        const title = (meta.title || '').slice(0, MAX_FIELD);

        let row;
        try {
          row = await tx(async (client) => {
            const ins = await client.query(
              `INSERT INTO timetables
                 (department, semester, title, template, explicit_durations, section_count,
                  file_name, file_bytes, file_size, file_sha256, warnings, uploaded_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
               RETURNING ${LIST_COLUMNS}`,
              [
                (meta.department || '').slice(0, MAX_FIELD),
                (meta.semester || '').slice(0, MAX_FIELD),
                title,
                meta.template,
                explicit,
                sections.length,
                fileName,
                body,
                body.length,
                sha,
                JSON.stringify(warnings),
                user.id,
              ]
            );
            await insertSections(client, ins.rows[0].id, sections);
            return ins.rows[0];
          });
        } catch (err) {
          if (err && err.code === '23505') {
            throw new HttpError(409, 'This exact file has already been uploaded');
          }
          throw err;
        }

        await recordAudit(
          user,
          'timetable.upload',
          { type: 'timetable', id: row.id },
          `Uploaded "${row.title || fileName || 'Untitled'}" (${sections.length} sections)`,
          { fileName, fileSize: body.length, sectionCount: sections.length, warningCount: warnings.length },
        );
        sendJson(res, 201, { timetable: timetableDto(row), warnings });
      },
    },

    item: {
      async GET(req, res) {
        const user = await requireApprovedUser(req);
        const id = param(req, 'id');
        const row = await getVisibleTimetable(id, user, `${LIST_COLUMNS}, warnings`);
        const sections = await loadSections(row.id);
        const extra = user.role === 'admin' ? { warnings: row.warnings } : {};
        sendJson(res, 200, { timetable: timetableDto(row, extra), sections });
      },

      async PATCH(req, res) {
        const admin = await requireAdmin(req);
        const id = param(req, 'id');
        if (!isUuid(id)) throw new HttpError(404, 'Timetable not found');

        const body = await jsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new HttpError(422, 'Expected a JSON object');
        }
        const sets = [];
        const values = [];
        const add = (column, value) => {
          values.push(value);
          sets.push(`${column} = $${values.length}`);
        };
        if (body.department !== undefined) add('department', cleanText(body.department, 'department'));
        if (body.semester !== undefined) add('semester', cleanText(body.semester, 'semester'));
        if (body.title !== undefined) add('title', cleanText(body.title, 'title', { required: true }));
        if (body.isPublished !== undefined) {
          if (typeof body.isPublished !== 'boolean') throw new HttpError(422, 'isPublished must be true or false');
          add('is_published', body.isPublished);
        }
        if (!sets.length) throw new HttpError(422, 'Nothing to update');

        const prev = (await query(`SELECT ${LIST_COLUMNS} FROM timetables WHERE id = $1`, [id])).rows[0];
        if (!prev) throw new HttpError(404, 'Timetable not found');

        values.push(id);
        const { rows } = await query(
          `UPDATE timetables SET ${sets.join(', ')}, updated_at = now()
           WHERE id = $${values.length} RETURNING ${LIST_COLUMNS}`,
          values
        );
        if (!rows[0]) throw new HttpError(404, 'Timetable not found');
        await auditTimetableEdit(admin, prev, rows[0]);
        sendJson(res, 200, { timetable: timetableDto(rows[0]) });
      },

      async DELETE(req, res) {
        const admin = await requireAdmin(req);
        const id = param(req, 'id');
        if (!isUuid(id)) throw new HttpError(404, 'Timetable not found');
        const { rows } = await query(
          'DELETE FROM timetables WHERE id = $1 RETURNING id, title, file_name, section_count',
          [id]
        );
        if (!rows[0]) throw new HttpError(404, 'Timetable not found');
        await recordAudit(
          admin,
          'timetable.delete',
          { type: 'timetable', id },
          `Deleted "${rows[0].title || rows[0].file_name || 'Untitled'}"`,
          { fileName: rows[0].file_name, sectionCount: rows[0].section_count }
        );
        sendJson(res, 200, { ok: true });
      },
    },
  };
}

async function auditTimetableEdit(admin, before, after) {
  const changes = {};
  for (const [field, column] of [
    ['department', 'department'],
    ['semester', 'semester'],
    ['title', 'title'],
    ['isPublished', 'is_published'],
  ]) {
    if (before[column] !== after[column]) changes[field] = { from: before[column], to: after[column] };
  }
  if (!Object.keys(changes).length) return;
  const target = { type: 'timetable', id: after.id };
  const name = after.title || after.file_name || 'Untitled';
  if (changes.isPublished) {
    const published = after.is_published;
    await recordAudit(admin, published ? 'timetable.publish' : 'timetable.unpublish', target,
      `${published ? 'Published' : 'Unpublished'} "${name}"`, changes);
    delete changes.isPublished;
  }
  if (Object.keys(changes).length) {
    await recordAudit(admin, 'timetable.edit', target, `Edited ${Object.keys(changes).join(', ')} of "${name}"`, changes);
  }
}
