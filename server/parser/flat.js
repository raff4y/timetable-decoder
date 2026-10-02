// Flat "List of Courses" template (e.g. the EE department): one row per
// Code/Course/Section/Teacher/Day/Time/Room. Ported from app.js.
// Start times only - durations are not stated, so every meeting has durMin: null
// and the client applies its theory/lab defaults.

import { parseDay, parseTimeToMinutes } from './time.js';
import { finishSections, findSemester, titleAboveRow } from './common.js';

const HEADER_COLS = ['code', 'course', 'section', 'teacher', 'day', 'time', 'room', 'batch'];
const REQUIRED_COLS = ['code', 'course', 'section', 'teacher', 'day', 'time', 'room'];

export function findHeaderRow(rows) {
  let best = null;
  const limit = Math.min(rows.length, 10);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] || [];
    const colMap = {};
    let score = 0;
    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c]).trim().toLowerCase();
      if (HEADER_COLS.indexOf(cell) !== -1 && colMap[cell] === undefined) {
        colMap[cell] = c;
        if (REQUIRED_COLS.indexOf(cell) !== -1) score++;
      }
    }
    if (!best || score > best.score) best = { rowIdx: i, score, colMap };
  }
  return best && best.score >= 5 &&
    best.colMap.day !== undefined && best.colMap.time !== undefined ? best : null;
}

export function parseFlatSheet(sheet, fileName, warnings) {
  const col = sheet.header.colMap;
  const rows = sheet.rows;

  const title = titleAboveRow(rows, sheet.header.rowIdx);
  const deptMatch = /\[([^\]]+)\]/.exec(title);
  const meta = {
    title,
    department: deptMatch ? deptMatch[1].trim() : '',
    semester: findSemester(title, fileName),
    fileName: fileName || '',
  };

  const byKey = new Map();
  let skipped = 0;
  for (let i = sheet.header.rowIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const code = String(row[col.code] || '').trim();
    const name = String(row[col.course] || '').trim();
    const section = String(row[col.section] || '').trim();
    if (!code || !section) continue;

    const dayIdx = parseDay(row[col.day]);
    const startMin = parseTimeToMinutes(row[col.time]);
    if (dayIdx === null || startMin === null) {
      skipped++;
      continue;
    }

    const key = code + '|' + section;
    let sec = byKey.get(key);
    if (!sec) {
      sec = {
        code,
        name,
        section,
        teacher: String(row[col.teacher] || '').trim(),
        batch: col.batch !== undefined ? String(row[col.batch] || '').trim() : '',
        nameIsLab: /\blab\b/i.test(name),
        meetings: [],
      };
      byKey.set(key, sec);
    }
    if (!sec.teacher) sec.teacher = String(row[col.teacher] || '').trim();

    const duplicate = sec.meetings.some((m) => m.dayIdx === dayIdx && m.startMin === startMin);
    if (!duplicate) {
      sec.meetings.push({
        dayIdx,
        startMin,
        rawTime: String(row[col.time]).trim(),
        room: String(row[col.room] || '').trim(),
        durMin: null,
      });
    }
  }

  if (skipped) {
    warnings.push(`${skipped} row${skipped === 1 ? '' : 's'} skipped because the day or time could not be read.`);
  }

  return {
    meta,
    sections: finishSections(byKey, 'Found the course-list sheet but no readable rows in it.'),
  };
}
