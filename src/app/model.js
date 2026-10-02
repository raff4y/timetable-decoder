// Pure logic for the timetable tool (no DOM): section keys and colours, durations,
// conflict detection, catalog grouping, the API-to-app section adapter and the
// saved-schedule restore/serialize helpers. app.js wires these to the page.

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

export const DEFAULT_THEORY_MIN = 80;
export const DEFAULT_LAB_MIN = 150;

export const NUCESRATE_SEARCH = 'https://nucesrate.vercel.app/professors';

// Limits enforced by PUT /api/schedules (api/schedules/_lib.js); we stay inside them.
const MAX_SECTION_KEYS = 200;
const MAX_KEY_LENGTH = 120;
const MAX_COLOR_ENTRIES = 200;
const MAX_COLOR_KEY_LENGTH = 200;

// ----------------------------------------------------------------- identity

export function sectionKey(sec) {
  return sec.code + '|' + sec.section;
}

export function baseNameKey(name) {
  // "Physics Lab", "Physics - Lab", "Physics (Lab)" all share the theory course's colour.
  return String(name).replace(/\s*[-–-]?\s*\(?\blab\b\)?\s*$/i, '').trim().toLowerCase();
}

// ------------------------------------------------------------------- colours

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function shadeHex(hex, amount) {
  // amount > 0 lightens toward white, < 0 darkens toward black
  const rgb = hexToRgb(hex);
  const target = amount > 0 ? 255 : 0;
  const f = Math.abs(amount);
  const out = rgb.map((c) => Math.round(c + (target - c) * f));
  return '#' + out.map((c) => c.toString(16).padStart(2, '0')).join('');
}

function relativeLuminance(hex) {
  const rgb = hexToRgb(hex).map((c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrastRatio(l1, l2) {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** White or ink, whichever reads better on the given fill. */
export function labelColorOn(fillHex, inkHex) {
  const l = relativeLuminance(fillHex);
  return contrastRatio(l, 1) >= contrastRatio(l, relativeLuminance(inkHex)) ? '#ffffff' : inkHex;
}

/**
 * Remembers which palette slot each course (by base name) was given. Slots only
 * ever count up, so removing a section never frees its colour for reuse.
 */
export class ColorBook {
  constructor() {
    this.slots = new Map();
    this.nextSlot = 0;
  }

  /** Rebuild from a saved `colorAssignments` object; non-integer values are ignored. */
  static fromSaved(saved) {
    const book = new ColorBook();
    if (!saved || typeof saved !== 'object') return book;
    for (const [key, slot] of Object.entries(saved)) {
      if (Number.isInteger(slot) && slot >= 0) {
        book.slots.set(key, slot);
        book.nextSlot = Math.max(book.nextSlot, slot + 1);
      }
    }
    return book;
  }

  slotFor(sec) {
    const key = baseNameKey(sec.name);
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = this.nextSlot++;
      this.slots.set(key, slot);
    }
    return slot;
  }

  hexFor(sec) {
    const slot = this.slotFor(sec);
    let hex = PALETTE[slot % PALETTE.length];
    const pass = Math.floor(slot / PALETTE.length);
    if (pass > 0) hex = shadeHex(hex, pass % 2 === 1 ? 0.18 : -0.18);
    return hex;
  }

  toJSON() {
    const out = {};
    let n = 0;
    for (const [key, slot] of this.slots) {
      if (!key || key.length > MAX_COLOR_KEY_LENGTH) continue;
      if (n++ >= MAX_COLOR_ENTRIES) break;
      out[key] = slot;
    }
    return out;
  }
}

// ----------------------------------------------------------------- formatting

export function fmtMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = ((h + 11) % 12) + 1;
  return h12 + ':' + String(m).padStart(2, '0') + suffix;
}

export function fmtHourLabel(hour) {
  const h12 = ((hour + 11) % 12) + 1;
  return h12 + (hour < 12 ? ' AM' : ' PM');
}

export function sectionMeetingSummary(sec) {
  const abbrs = sec.meetings.map((m) => WEEKDAYS[m.dayIdx].slice(0, 3));
  const times = sec.meetings.map((m) => m.rawTime);
  const allSameTime = times.every((t) => t === times[0]);
  let summary = allSameTime && times.length
    ? abbrs.join('/') + ' ' + times[0]
    : sec.meetings.map((m, i) => abbrs[i] + ' ' + m.rawTime).join(', ');
  const rooms = sec.meetings.map((m) => m.room).filter(Boolean);
  const uniqueRooms = rooms.filter((r, i) => rooms.indexOf(r) === i);
  if (uniqueRooms.length === 1) summary += ' · ' + uniqueRooms[0];
  return summary;
}

// ---------------------------------------------------------------- API adapter

/**
 * GET /api/timetables/:id returns sections in the shape the UI consumes
 * ({ code, name, section, teacher, batch, nameIsLab, meetings: [{ dayIdx, startMin,
 * rawTime, room, durMin, isLab }] }); this normalizes types defensively, drops
 * anything unusable and sorts meetings. `durMin: null` still means "use the
 * theory/lab inputs".
 */
export function adaptSections(apiSections) {
  if (!Array.isArray(apiSections)) return [];
  const out = [];
  for (const s of apiSections) {
    if (!s || !s.code || !s.section) continue;
    const meetings = [];
    for (const m of Array.isArray(s.meetings) ? s.meetings : []) {
      if (!m || !Number.isInteger(m.dayIdx) || m.dayIdx < 0 || m.dayIdx > 6) continue;
      if (!Number.isFinite(m.startMin)) continue;
      meetings.push({
        dayIdx: m.dayIdx,
        startMin: m.startMin,
        rawTime: String(m.rawTime ?? ''),
        room: String(m.room ?? ''),
        durMin: Number.isFinite(m.durMin) && m.durMin > 0 ? m.durMin : null,
        isLab: typeof m.isLab === 'boolean' ? m.isLab : undefined,
      });
    }
    meetings.sort((a, b) => (a.dayIdx - b.dayIdx) || (a.startMin - b.startMin));
    out.push({
      code: String(s.code),
      name: String(s.name ?? ''),
      section: String(s.section),
      teacher: String(s.teacher ?? ''),
      batch: String(s.batch ?? ''),
      nameIsLab: Boolean(s.nameIsLab),
      meetings,
    });
  }
  return out;
}

/** True when every meeting states its own length (timetable.explicitDurations). */
export function allDurationsExplicit(sections) {
  return sections.every((sec) => sec.meetings.every((m) => m.durMin));
}

// ------------------------------------------------------------------ durations

export function meetingIsLab(sec, meeting) {
  if (typeof meeting.isLab === 'boolean') return meeting.isLab;
  return Boolean(sec.nameIsLab || /lab/i.test(meeting.room));
}

/** `defaults` = { theoryMin, labMin }, applied when the meeting has no explicit length. */
export function meetingDuration(sec, meeting, defaults) {
  if (meeting.durMin) return meeting.durMin;
  return meetingIsLab(sec, meeting) ? defaults.labMin : defaults.theoryMin;
}

// ------------------------------------------------------------ saved schedules

/** Body for PUT /api/schedules/:timetableId. */
export function serializeSchedule(selected, colorBook) {
  const sectionKeys = [];
  for (const key of selected.keys()) {
    if (key.length <= MAX_KEY_LENGTH) sectionKeys.push(key);
    if (sectionKeys.length >= MAX_SECTION_KEYS) break;
  }
  return { sectionKeys, colorAssignments: colorBook.toJSON() };
}

/**
 * Apply a saved schedule to a freshly loaded timetable. Keys that no longer
 * exist in `sections` are ignored. Returns the selection (insertion order =
 * saved order) and the colour book, plus how many keys were dropped.
 */
export function restoreSchedule(sections, saved) {
  const byKey = new Map(sections.map((s) => [sectionKey(s), s]));
  const selected = new Map();
  const colors = ColorBook.fromSaved(saved && saved.colorAssignments);
  let dropped = 0;
  const keys = saved && Array.isArray(saved.sectionKeys) ? saved.sectionKeys : [];
  for (const key of keys) {
    const sec = byKey.get(key);
    if (!sec) {
      dropped++;
      continue;
    }
    selected.set(key, sec);
    colors.slotFor(sec); // assigns a slot only if the save had none for this course
  }
  return { selected, colors, dropped };
}

// ----------------------------------------------------------- picker grouping

/** Departments sorted A-Z, each with its timetables newest semester-ish first by upload date. */
export function groupTimetables(timetables) {
  const groups = new Map();
  for (const t of timetables) {
    const dept = (t.department || '').trim() || 'Other';
    if (!groups.has(dept)) groups.set(dept, []);
    groups.get(dept).push(t);
  }
  return Array.from(groups.entries())
    .sort((a, b) => (a[0] === 'Other') - (b[0] === 'Other') || a[0].localeCompare(b[0]))
    .map(([department, items]) => ({
      department,
      items: items.slice().sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt))),
    }));
}

export function timetableOptionLabel(t, { showDraft = false } = {}) {
  const base = (t.semester || '').trim() || (t.title || '').trim() || 'Timetable';
  const count = t.sectionCount === 1 ? '1 section' : `${t.sectionCount} sections`;
  return `${base} · ${count}${showDraft && !t.isPublished ? ' · unpublished' : ''}`;
}

// ------------------------------------------------------------------- examples

export const GENERIC_EXAMPLES = {
  code: 'the course code',
  codeSection: 'CODE-SECTION',
  codeSection2: '',
  nameWord: '',
};

export function pickExamples(sections) {
  let first = null;
  let second = null;
  for (const sec of sections) {
    if (!sec.code || !sec.section || sec.code === sec.name) continue;
    if (!first) first = sec;
    else if (sec.code !== first.code) {
      second = sec;
      break;
    }
  }
  if (!first) return GENERIC_EXAMPLES;

  let word = '';
  (first.name || '').split(/[^A-Za-z]+/).forEach((w) => {
    if (w.length > word.length) word = w;
  });

  return {
    code: first.code,
    codeSection: first.code + '-' + first.section,
    codeSection2: second ? second.code + '-' + second.section : '',
    nameWord: word.length > 3 ? word : '',
  };
}

// -------------------------------------------------------------------- reviews

export function reviewSearchName(teacher) {
  // Strip parentheticals ("(Visiting)") and leading honorifics, which NUCESRate's search doesn't index.
  let name = String(teacher || '').replace(/\([^)]*\)/g, '');
  const honorific = /^\s*(?:dr|mr|mrs|ms|miss|prof|professor|engr|sir|madam|mam)\b\.?\s+/i;
  while (honorific.test(name)) name = name.replace(honorific, '');
  return name.replace(/\s+/g, ' ').trim();
}

export function hasReviewLink(teacher) {
  const name = reviewSearchName(teacher);
  if (name.length < 2) return false;
  // Placeholders that stand in for a teacher ("TBA", "Lab Engineer") have no reviews page.
  if (/^(tba|tbd|n\/?a|staff)$/i.test(name)) return false;
  if (/^(lab\s*(engineer|instructor|attendant)|teaching\s*assistant|ta|visiting\s*faculty|to\s*be\s*(announced|decided))\b/i.test(name)) return false;
  return true;
}

export function reviewUrl(teacher, campus) {
  let url = NUCESRATE_SEARCH + '?pg=1&prof=' + encodeURIComponent(reviewSearchName(teacher));
  if (campus) url += '&campus=' + encodeURIComponent(campus);
  return url;
}

// ----------------------------------------------------- search / quick add / catalog

export function courseGroups(sections, query) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map();
  sections.forEach((sec) => {
    if (tokens.length) {
      const hay = (sec.code + ' ' + sec.name + ' ' + sec.section).toLowerCase();
      if (!tokens.every((t) => hay.indexOf(t) !== -1)) return;
    }
    const gKey = sec.code + '|' + sec.name;
    let g = groups.get(gKey);
    if (!g) {
      g = { code: sec.code, name: sec.name, sections: [] };
      groups.set(gKey, g);
    }
    g.sections.push(sec);
  });
  return Array.from(groups.values());
}

export function resolveQuickAddToken(sections, token) {
  const codeMatch = /[A-Za-z]{2,}\d{3,}/.exec(token);
  if (!codeMatch) return { ok: false, reason: 'no course code found' };

  const codeUpper = codeMatch[0].toUpperCase();
  const ofCode = sections.filter((s) => s.code.toUpperCase() === codeUpper);
  if (!ofCode.length) return { ok: false, reason: 'unknown code "' + codeMatch[0] + '"' };

  const remainder = (token.slice(0, codeMatch.index) + token.slice(codeMatch.index + codeMatch[0].length))
    .replace(/[^A-Za-z0-9]+/g, '').toLowerCase();

  if (!remainder) {
    if (ofCode.length === 1) return { ok: true, section: ofCode[0] };
    return { ok: false, reason: codeUpper + ' has ' + ofCode.length + ' sections - add one, e.g. ' + codeUpper + '-' + ofCode[0].section };
  }

  const norm = (s) => s.replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
  const match =
    ofCode.find((s) => norm(s.section) === remainder) ||
    ofCode.find((s) => norm(s.section).slice(-remainder.length) === remainder) ||
    ofCode.find((s) => norm(s.section).indexOf(remainder) !== -1);

  if (!match) return { ok: false, reason: 'no section of ' + codeUpper + ' matches "' + remainder + '"' };
  return { ok: true, section: match };
}

export function matchesFilter(hay, tokens) {
  if (!tokens.length) return true;
  hay = hay.toLowerCase();
  return tokens.every((t) => hay.indexOf(t) !== -1);
}

export function teacherCatalog(sections) {
  const byTeacher = new Map();
  sections.forEach((sec) => {
    const name = sec.teacher || 'TBA';
    let entry = byTeacher.get(name);
    if (!entry) {
      entry = { name, courses: new Map(), sectionCount: 0 };
      byTeacher.set(name, entry);
    }
    entry.sectionCount++;
    const cKey = sec.code + '|' + sec.name;
    let course = entry.courses.get(cKey);
    if (!course) {
      course = { code: sec.code, name: sec.name, sectionCount: 0 };
      entry.courses.set(cKey, course);
    }
    course.sectionCount++;
  });
  const teachers = Array.from(byTeacher.values());
  teachers.sort((a, b) => {
    if (a.name === 'TBA') return 1;
    if (b.name === 'TBA') return -1;
    return a.name.localeCompare(b.name);
  });
  return teachers;
}

export function teacherInitials(name) {
  const words = name.split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map((w) => w.charAt(0)).join('');
  return initials.toUpperCase() || '?';
}

export function sectionParts(label) {
  // "BCS-3A1" -> base "BCS-3A", sub "1"; combined labels ("3A/3B") use their first half.
  const primary = String(label || '').split('/')[0].trim();
  const m = /^(.*?)-?(\d+)\s*([A-Za-z]+)(\d+)?$/.exec(primary);
  if (!m) return { base: primary || label, sub: null };
  const base = (m[1] ? m[1] + '-' : '') + m[2] + m[3].toUpperCase();
  return { base, sub: m[4] || null };
}

export function sectionCatalog(sections) {
  const bases = new Map();
  sections.forEach((sec) => {
    const parts = sectionParts(sec.section);
    let base = bases.get(parts.base);
    if (!base) {
      base = { label: parts.base, subs: new Map(), total: 0 };
      bases.set(parts.base, base);
    }
    base.total++;
    let sub = base.subs.get(sec.section);
    if (!sub) {
      sub = { label: sec.section, isSub: !!parts.sub, sections: [] };
      base.subs.set(sec.section, sub);
    }
    sub.sections.push(sec);
  });

  const list = Array.from(bases.values());
  list.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  list.forEach((base) => {
    base.subList = Array.from(base.subs.values()).sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true }));
  });
  return list;
}

// ----------------------------------------------------- events and conflicts

export function selectedEvents(selected, defaults) {
  const events = [];
  selected.forEach((sec) => {
    sec.meetings.forEach((meeting) => {
      const start = meeting.startMin;
      events.push({
        sec,
        meeting,
        dayIdx: meeting.dayIdx,
        start,
        end: start + meetingDuration(sec, meeting, defaults),
        isLab: meetingIsLab(sec, meeting),
      });
    });
  });
  return events;
}

export function findConflicts(events) {
  const conflicts = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];
      if (a.dayIdx !== b.dayIdx) continue;
      if (a.sec === b.sec) continue; // a section never conflicts with itself
      if (a.start < b.end && b.start < a.end) conflicts.push([a, b]);
    }
  }
  return conflicts;
}

export function computeGrid(events) {
  const dayIdxs = [0, 1, 2, 3, 4];
  if (events.some((ev) => ev.dayIdx === 5)) dayIdxs.push(5);

  let startHour = 8;
  let endHour = 18;
  if (events.length) {
    const minStart = Math.min(...events.map((ev) => ev.start));
    const maxEnd = Math.max(...events.map((ev) => ev.end));
    startHour = Math.min(Math.floor(minStart / 60), 8);
    endHour = Math.max(Math.ceil(maxEnd / 60), 18);
  }
  return { dayIdxs, startHour, endHour };
}

/** Side-by-side slices for overlapping events on one day (sets ev._slice / ev._sliceCount). */
export function assignOverlapSlices(dayEvents) {
  dayEvents.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  const clusters = [];
  let current = null;
  let currentMaxEnd = -1;
  dayEvents.forEach((ev) => {
    if (!current || ev.start >= currentMaxEnd) {
      current = [];
      clusters.push(current);
      currentMaxEnd = ev.end;
    } else {
      currentMaxEnd = Math.max(currentMaxEnd, ev.end);
    }
    current.push(ev);
  });

  clusters.forEach((cluster) => {
    const columnEnds = [];
    cluster.forEach((ev) => {
      let placed = false;
      for (let c = 0; c < columnEnds.length; c++) {
        if (ev.start >= columnEnds[c]) {
          ev._slice = c;
          columnEnds[c] = ev.end;
          placed = true;
          break;
        }
      }
      if (!placed) {
        ev._slice = columnEnds.length;
        columnEnds.push(ev.end);
      }
    });
    cluster.forEach((ev) => { ev._sliceCount = columnEnds.length; });
  });
}
