// Period-grid template (FAST School of Computing / Management): a
// rooms-by-periods grid in 10-minute columns, joined with the course-list
// sheet(s) for full titles, codes and instructors. Ported from app.js; the
// heuristics are intentionally unchanged.

import { findTimeRange, fmtMinutes, parseDay, parsePeriodHeader } from './time.js';
import { finishSections, findSemester, titleAboveRow } from './common.js';

export function detectGrid(rows) {
  const limit = Math.min(rows.length, 10);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] || [];
    const periodCols = [];
    for (let c = 0; c < row.length; c++) {
      const range = parsePeriodHeader(row[c]);
      if (range) periodCols.push({ col: c, startMin: range.startMin, endMin: range.endMin });
    }
    if (periodCols.length >= 3) {
      // Minutes per column, from the first two period headers.
      let step = (periodCols[1].startMin - periodCols[0].startMin) /
                 (periodCols[1].col - periodCols[0].col);
      if (!(step > 0 && step <= 60)) step = 10;

      let dataStart = i + 1;
      for (let j = i + 1; j < Math.min(rows.length, i + 4); j++) {
        const cells = (rows[j] || []).map((x) => String(x).trim().toLowerCase());
        if (cells.indexOf('days') !== -1 || cells.indexOf('day') !== -1) {
          dataStart = j + 1;
          break;
        }
      }
      return { periodRow: i, periodCols, step, dataStart };
    }
  }
  return null;
}

function periodForCol(grid, c) {
  let p = grid.periodCols[0];
  for (let i = 0; i < grid.periodCols.length; i++) {
    if (grid.periodCols[i].col <= c) p = grid.periodCols[i];
    else break;
  }
  return p;
}

function gridTimeForCol(grid, c) {
  const p = periodForCol(grid, c);
  return p.startMin + (c - p.col) * grid.step;
}

const SECTION_TOKEN_RE = /\b([A-Z]{2,6}\d?-\d[A-Za-z]?\d?(?:\/\d[A-Za-z]?\d?)?)\b/;

/** One grid cell -> [{ title, section, teacher, range }]; a cell can hold two co-scheduled courses. */
export function parseGridCellEntries(text) {
  let s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return [];

  // A time typed inside the cell wins over the drawn width; cut it out of the text.
  const range = findTimeRange(s);
  if (range) s = (s.slice(0, range.index) + ' ' + s.slice(range.end)).replace(/\s+/g, ' ').trim();

  const groups = [];
  const paren = /\(([^()]*)\)/g;
  let m;
  while ((m = paren.exec(s)) !== null) {
    groups.push({ section: m[1].trim(), start: m.index, end: paren.lastIndex });
  }

  const entries = [];
  let cursor = 0;
  let lastTitle = '';
  for (let i = 0; i < groups.length; i++) {
    const title = s.slice(cursor, groups[i].start).replace(/^[\s&\/,;:-]+/, '').trim() || lastTitle;
    const tailEnd = i + 1 < groups.length ? groups[i + 1].start : s.length;
    let tail = s.slice(groups[i].end, tailEnd);
    cursor = tailEnd;
    if (i + 1 < groups.length) {
      // Two courses in one cell: split the tail at the joiner.
      const joiner = /\s[&\/+]\s/.exec(tail);
      if (joiner) {
        cursor = groups[i].end + joiner.index + joiner[0].length;
        tail = tail.slice(0, joiner.index);
      }
    }
    const teacher = tail.replace(/^[\s:,-]+/, '').replace(/[\s&\/,;:-]+$/, '').trim();
    lastTitle = title;
    if (title && groups[i].section) {
      entries.push({ title, section: groups[i].section, teacher, range });
    }
  }

  if (!entries.length) {
    // No usable brackets (mistyped or missing): look for a bare section token.
    const token = SECTION_TOKEN_RE.exec(s);
    if (token) {
      const before = s.slice(0, token.index).replace(/[\s()\[\],;:-]+$/, '').trim();
      const after = s.slice(token.index + token[0].length).replace(/^[\s()\[\],;:-]+/, '').trim();
      if (before) entries.push({ title: before, section: token[1], teacher: after, range });
    }
  }
  return entries;
}

export function findCourseListHeader(rows) {
  const limit = Math.min(rows.length, 6);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] || [];
    const map = {};
    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c]).trim().toLowerCase();
      if (cell === 'code' && map.code === undefined) map.code = c;
      else if (/^course(\s*(title|name))?$/.test(cell) && map.name === undefined) map.name = c;
      else if (cell === 'section' && map.section === undefined) map.section = c;
      else if (/^(instructor(\s*name)?|teacher)$/.test(cell) && map.teacher === undefined) map.teacher = c;
      else if (/^course\s*short/.test(cell) && map.shortTitle === undefined) map.shortTitle = c;
      else if (/^instructor\s*short/.test(cell) && map.shortTeacher === undefined) map.shortTeacher = c;
      else if (/^duration/.test(cell) && map.duration === undefined) map.duration = c;
      else if (/^offered/.test(cell) && map.batch === undefined) map.batch = c;
    }
    if (map.code !== undefined && map.section !== undefined && map.name !== undefined) {
      return { rowIdx: i, colMap: map };
    }
  }
  return null;
}

export function parseGridWorkbook(sheetsData, grids, fileName, warnings) {
  const tight = (s) => String(s).replace(/[^a-z0-9]/gi, '').toLowerCase();
  // Lab subsections (BAF-1A1) fall back to their parent row (BAF-1A).
  const baseSectionKey = (s) => tight(s).replace(/([a-z])\d$/, '$1');
  // Drop a trailing qualifier such as "(Elective)".
  const plainTitle = (s) => String(s).replace(/\s*\([^)]*\)\s*$/, '').trim();
  const cleanTeacher = (s) => {
    const t = String(s || '').trim();
    return /^(added|tba|tbd|n\/?a|-+)$/i.test(t) ? '' : t;
  };

  const infoByKey = new Map();
  const infoByBase = new Map();
  const titleIndex = [];
  const titleSlot = new Map();

  function indexCourse(info, titles, section) {
    titles.forEach((t) => {
      if (!t) return;
      const exactKey = tight(t) + '|' + tight(section);
      if (!infoByKey.has(exactKey)) infoByKey.set(exactKey, info);

      const bk = tight(plainTitle(t));
      if (!bk) return;
      const bsk = baseSectionKey(section);
      if (!infoByBase.has(bk + '|' + bsk)) infoByBase.set(bk + '|' + bsk, info);

      let slot = titleSlot.get(bk);
      if (slot === undefined) {
        slot = titleIndex.length;
        titleSlot.set(bk, slot);
        titleIndex.push({ key: bk, bySection: new Map(), first: info });
      }
      if (!titleIndex[slot].bySection.has(bsk)) titleIndex[slot].bySection.set(bsk, info);
    });
  }

  function lookupCourse(title, section) {
    const exact = infoByKey.get(tight(title) + '|' + tight(section));
    if (exact) return { info: exact, exact: true };

    const bk = tight(plainTitle(title));
    const bsk = baseSectionKey(section);
    const loose = infoByBase.get(bk + '|' + bsk);
    if (loose) return { info: loose, exact: false };

    let best = null;
    for (let i = 0; i < titleIndex.length; i++) {
      const entry = titleIndex[i];
      if (entry.key.length < 10) continue;
      if (bk.indexOf(entry.key) !== 0 && entry.key.indexOf(bk) !== 0) continue;
      if (!best || entry.key.length > best.key.length) best = entry;
    }
    if (!best) return null;
    return { info: best.bySection.get(bsk) || best.first, exact: false };
  }

  sheetsData.forEach((sd) => {
    if (detectGrid(sd.rows)) return;
    const header = findCourseListHeader(sd.rows);
    if (!header) return;
    const map = header.colMap;
    for (let i = header.rowIdx + 1; i < sd.rows.length; i++) {
      const row = sd.rows[i] || [];
      const code = String(row[map.code] || '').trim();
      const section = String(row[map.section] || '').trim();
      if (!code || !section) continue;
      const name = String(row[map.name] || '').trim();
      const shortTitle = map.shortTitle !== undefined ? String(row[map.shortTitle] || '').trim() : '';
      indexCourse({
        code,
        name: name || shortTitle,
        teacher: map.teacher !== undefined ? cleanTeacher(row[map.teacher]) : '',
        batch: map.batch !== undefined ? String(row[map.batch] || '').trim() : '',
        duration: map.duration !== undefined ? (parseInt(row[map.duration], 10) || null) : null,
      }, [shortTitle, name], section);
    }
  });

  const byKey = new Map();
  const unmatchedTitles = new Set();

  function addMeeting(entry, place) {
    const found = lookupCourse(entry.title, entry.section);
    const info = found ? found.info : null;
    if (!info) unmatchedTitles.add(entry.title);
    const gridTeacher = cleanTeacher(entry.teacher);

    // An exact course-list match is authoritative for the instructor; a fuzzy
    // match prefers what the grid cell itself says.
    const teacher = found && found.exact
      ? (info.teacher || gridTeacher)
      : (gridTeacher || (info && info.teacher) || '');

    const code = info ? info.code : entry.title;
    const name = info ? info.name : entry.title;
    const key = code + '|' + entry.section;
    let sec = byKey.get(key);
    if (!sec) {
      sec = {
        code,
        name,
        section: entry.section,
        teacher,
        batch: (info && info.batch) || '',
        nameIsLab: /\blab\b/i.test(name),
        meetings: [],
      };
      byKey.set(key, sec);
    }
    if (!sec.teacher) sec.teacher = teacher;

    const dup = sec.meetings.some((mm) => mm.dayIdx === place.dayIdx && mm.startMin === place.startMin);
    if (dup) return;

    // Class length: typed time, else merged block width, else the course list, else the rest of the period.
    let durMin = null;
    if (entry.range) durMin = entry.range.endMin - entry.range.startMin;
    else if (place.span >= 2) durMin = Math.round(place.span * place.step);
    else if (info && info.duration) durMin = info.duration;
    else if (place.period && place.period.endMin > place.startMin) {
      durMin = place.period.endMin - place.startMin;
    }

    sec.meetings.push({
      dayIdx: place.dayIdx,
      startMin: place.startMin,
      rawTime: fmtMinutes(place.startMin),
      room: place.room,
      durMin,
    });
  }

  // Prefer the "combined" grid sheet when there is one, else use every grid.
  let chosen = grids.filter((g) => /combined/i.test(g.name));
  if (!chosen.length) chosen = grids;

  const pending = [];
  chosen.forEach((g) => {
    const grid = g.grid;
    const rows = g.rows;
    const firstPeriodCol = grid.periodCols[0].col;
    const spans = {};
    (g.ws['!merges'] || []).forEach((m) => {
      if (m.s.r === m.e.r) spans[m.s.r + ',' + m.s.c] = m.e.c - m.s.c + 1;
    });

    let currentDay = null;
    for (let r = grid.dataStart; r < rows.length; r++) {
      const row = rows[r] || [];
      const dayCell = String(row[0] || '').trim();
      if (dayCell) currentDay = parseDay(dayCell);
      const room = String(row[1] || '').trim();
      if (currentDay === null || !room) continue;

      for (let c = Math.max(2, firstPeriodCol); c < row.length; c++) {
        const entries = parseGridCellEntries(row[c]);
        if (!entries.length) continue;
        const span = spans[r + ',' + c] || 1;
        const period = periodForCol(grid, c);
        const colStart = gridTimeForCol(grid, c);
        entries.forEach((entry) => {
          pending.push({
            entry,
            place: {
              dayIdx: currentDay,
              room,
              startMin: entry.range ? entry.range.startMin : colStart,
              span,
              step: grid.step,
              period,
            },
          });
        });
      }
    }
  });

  // Where a file states a slot in words in one cell and draws it a column
  // early in another, snap the near-misses onto the stated time.
  const statedStarts = [];
  pending.forEach((item) => {
    if (item.entry.range && statedStarts.indexOf(item.entry.range.startMin) === -1) {
      statedStarts.push(item.entry.range.startMin);
    }
  });
  pending.forEach((item) => {
    if (item.entry.range) return;
    for (let i = 0; i < statedStarts.length; i++) {
      const drift = Math.abs(statedStarts[i] - item.place.startMin);
      if (drift > 0 && drift <= item.place.step) {
        item.place.startMin = statedStarts[i];
        break;
      }
    }
  });
  pending.forEach((item) => addMeeting(item.entry, item.place));

  const title = titleAboveRow(chosen[0].rows, chosen[0].grid.periodRow);
  const bracketed = /\[([^\]]+)\]/.exec(title);
  const meta = {
    title,
    department: bracketed ? bracketed[1].trim() : title.replace(/\s*time\s*table.*$/i, '').trim(),
    semester: findSemester(title, fileName),
    fileName: fileName || '',
  };

  if (unmatchedTitles.size) {
    const names = Array.from(unmatchedTitles);
    const shown = names.slice(0, 5).join('; ');
    warnings.push(
      `${names.length} course${names.length === 1 ? '' : 's'} in the grid ${names.length === 1 ? 'is' : 'are'} ` +
      `missing from the course-list sheet and kept their grid title in place of a code: ${shown}` +
      (names.length > 5 ? '; ...' : '') + '.'
    );
  }

  return {
    meta,
    sections: finishSections(byKey, 'Found a timetable grid but no readable class entries in it.'),
  };
}
