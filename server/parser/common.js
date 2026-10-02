// Helpers shared by the flat and grid parsers. Ported from app.js.

/** Thrown for any workbook we cannot turn into sections (the API maps it to 422). */
export class TimetableParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimetableParseError';
  }
}

export function finishSections(byKey, emptyError) {
  const sections = Array.from(byKey.values());
  sections.forEach((sec) => {
    sec.meetings.sort((a, b) => (a.dayIdx - b.dayIdx) || (a.startMin - b.startMin));
  });
  sections.sort((a, b) => a.code.localeCompare(b.code) || a.section.localeCompare(b.section));
  if (!sections.length) throw new TimetableParseError(emptyError);
  return sections;
}

export function findSemester(title, fileName) {
  const re = /(spring|summer|fall|winter)\s*[-']?\s*(\d{4})/i;
  const m = re.exec(title) || re.exec(fileName || '');
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() + ' ' + m[2] : '';
}

/** Longest non-empty cell above the header row. */
export function titleAboveRow(rows, rowIdx) {
  let title = '';
  for (let t = 0; t < rowIdx; t++) {
    (rows[t] || []).forEach((cell) => {
      const s = String(cell).trim();
      if (s.length > title.length) title = s;
    });
  }
  return title;
}

/** Same rule the client uses to pick a default class length (theory 80 / lab 150). */
export function meetingIsLab(sec, meeting) {
  return Boolean(sec.nameIsLab || /lab/i.test(meeting.room));
}
