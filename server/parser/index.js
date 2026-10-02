// Server-side timetable parser (ported from the browser parser in app.js).
//
//   parseWorkbook(buffer, fileName) -> { meta, sections, warnings }
//
// meta     { title, department, semester, fileName, template: 'flat' | 'grid' }
// sections [{ code, name, section, teacher, batch, nameIsLab,
//             meetings: [{ dayIdx, startMin, rawTime, room, durMin }] }]
//          sorted by code then section; meetings sorted by day then start.
// warnings string[] - non-fatal oddities found while parsing.
//
// Durations: `durMin` is null whenever the template does not state the class
// length (always for the flat template; for a grid meeting only if it cannot
// be derived). The UI used to read its theory/lab inputs inside the parser;
// now it must apply its own defaults (80 theory / 150 lab) for null durations,
// using `meetingIsLab(sec, meeting)` = sec.nameIsLab || /lab/i.test(room).
//
// Throws TimetableParseError when the file is not a recognisable timetable.

import * as XLSX from 'xlsx';
import { TimetableParseError } from './common.js';
import { findHeaderRow, parseFlatSheet } from './flat.js';
import { detectGrid, parseGridWorkbook } from './grid.js';

export { TimetableParseError, meetingIsLab } from './common.js';

const UNRECOGNIZED =
  'Could not recognize this timetable format - expected either a flat "List of Courses" sheet ' +
  '(Code/Course/Section/Teacher/Day/Time/Room) or a period-grid timetable sheet.';

export function parseWorkbook(buffer, fileName) {
  let wb;
  try {
    wb = XLSX.read(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), { type: 'buffer' });
  } catch (err) {
    throw new TimetableParseError('Could not read that file as an Excel workbook.');
  }

  const sheetsData = wb.SheetNames.map((name) => ({
    name,
    ws: wb.Sheets[name],
    rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' }),
  }));

  const warnings = [];

  const candidates = [];
  sheetsData.forEach((sd) => {
    const header = findHeaderRow(sd.rows);
    if (header) {
      candidates.push({
        name: sd.name,
        rows: sd.rows,
        header,
        nameBonus: /list/i.test(sd.name) && /course/i.test(sd.name) ? 1 : 0,
      });
    }
  });
  if (candidates.length) {
    candidates.sort((a, b) => (b.header.score - a.header.score) || (b.nameBonus - a.nameBonus));
    const parsed = parseFlatSheet(candidates[0], fileName, warnings);
    return { meta: { ...parsed.meta, template: 'flat' }, sections: parsed.sections, warnings };
  }

  const grids = [];
  sheetsData.forEach((sd) => {
    const grid = detectGrid(sd.rows);
    if (grid) grids.push({ name: sd.name, ws: sd.ws, rows: sd.rows, grid });
  });
  if (grids.length) {
    const parsed = parseGridWorkbook(sheetsData, grids, fileName, warnings);
    return { meta: { ...parsed.meta, template: 'grid' }, sections: parsed.sections, warnings };
  }

  throw new TimetableParseError(UNRECOGNIZED);
}
