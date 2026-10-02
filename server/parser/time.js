// Day / clock-time parsing shared by the flat and grid parsers.
// Pure functions, no DOM and no globals. Ported from app.js.

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const DAY_PREFIXES = {
  mon: 0, tue: 1, tues: 1, wed: 2, thu: 3, thur: 3, thurs: 3, fri: 4, sat: 5, sun: 6,
};

/** "8:30 AM" / "08:30" -> minutes since midnight, or null. Bare 1:00-6:59 means afternoon. */
export function parseTimeToMinutes(raw) {
  const s = String(raw).trim();
  let m = /^(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?/i.exec(s);
  if (m) {
    let h = parseInt(m[1], 10) % 12;
    if (m[3].toLowerCase() === 'p') h += 12;
    return h * 60 + parseInt(m[2], 10);
  }
  m = /^(\d{1,2}):(\d{2})\s*$/.exec(s);
  if (m) {
    let h24 = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    // Bare 1:00-6:59 can only be afternoon in a university timetable.
    if (h24 >= 1 && h24 < 7) h24 += 12;
    return h24 * 60 + min;
  }
  return null;
}

/** Day name or abbreviation -> 0 (Monday) .. 6 (Sunday), or null. */
export function parseDay(raw) {
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  for (const prefix in DAY_PREFIXES) {
    if (s.slice(0, prefix.length) === prefix) return DAY_PREFIXES[prefix];
  }
  return null;
}

/** Minutes since midnight -> "8:30am". */
export function fmtMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = ((h + 11) % 12) + 1;
  return h12 + ':' + String(m).padStart(2, '0') + suffix;
}

// The dash class holds a hyphen and an en dash (U+2013); the original source
// listed a hyphen twice, which is the same set.
const CLOCK_RE = /(\d{1,2})[:.](\d{2})\s*(a\.?\s*m\.?|p\.?\s*m\.?)?/gi;
const RANGE_SEP_RE = /^[\s.]*(?:to|till|until|[-–])[\s.]*$/i;

function clockToMinutes(hour, minute, meridiem) {
  let h = hour;
  if (meridiem) {
    h = h % 12;
    if (/p/i.test(meridiem)) h += 12;
  } else if (h >= 1 && h < 7) {
    h += 12;
  }
  return h * 60 + minute;
}

/** First "<clock> to <clock>" range inside free text, or null. */
export function findTimeRange(text) {
  const s = String(text);
  CLOCK_RE.lastIndex = 0;
  const a = CLOCK_RE.exec(s);
  if (!a) return null;
  const b = CLOCK_RE.exec(s);
  if (!b) return null;
  if (!RANGE_SEP_RE.test(s.slice(a.index + a[0].length, b.index))) return null;
  const startMin = clockToMinutes(parseInt(a[1], 10), parseInt(a[2], 10), a[3]);
  let endMin = clockToMinutes(parseInt(b[1], 10), parseInt(b[2], 10), b[3]);
  while (endMin <= startMin) endMin += 12 * 60;
  if (endMin - startMin > 8 * 60) return null;
  return { startMin, endMin, index: a.index, end: b.index + b[0].length };
}

/** A period header cell such as "08:30-10:00" (and nothing else) -> range, or null. */
export function parsePeriodHeader(text) {
  const s = String(text).trim();
  if (!s) return null;
  const range = findTimeRange(s);
  if (!range) return null;
  const rest = (s.slice(0, range.index) + s.slice(range.end)).replace(/[\s.:·-]/g, '');
  return rest ? null : range;
}
