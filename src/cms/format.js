// Pure formatting helpers for the CMS (no DOM), so they can be unit-tested.
// Dates are shown on Pakistan time, the same zone the server buckets days in
// (server/activity.js APP_TIME_ZONE).

export const TIME_ZONE = 'Asia/Karachi';
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const nf = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatNumber(n) {
  const v = Number(n) || 0;
  return Math.abs(v) >= 10_000 ? compact.format(v) : nf.format(Math.round(v * 10) / 10);
}

export function formatDecimal(n, digits = 1) {
  return (Number(n) || 0).toFixed(digits).replace(/\.0+$/, '');
}

export function plural(n, one, many = `${one}s`) {
  return `${formatNumber(n)} ${Number(n) === 1 ? one : many}`;
}

function parts(date, options) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, ...options }).format(date);
}

export function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : parts(d, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const time = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' })
    .format(d)
    .replace(' ', '')
    .toLowerCase();
  return `${formatDate(iso)}, ${time}`;
}

/** "Just now", "5 min ago", "3 h ago", "Yesterday", "4 days ago", else the date. */
export function timeAgo(iso, now = Date.now()) {
  if (!iso) return 'Never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'Never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'Just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'Yesterday';
  if (d < 30) return `${d} days ago`;
  return formatDate(iso);
}

/** 'YYYY-MM-DD' (a calendar day, not an instant) -> '1 Oct'. */
export function shortDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!m) return day || '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(d);
}

export function longDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!m) return day || '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${formatDecimal(v / 1024)} KB`;
  return `${formatDecimal(v / (1024 * 1024))} MB`;
}

/** Minutes since midnight -> '8:30am'. */
export function minutesToTime(min) {
  const v = Math.max(0, Math.round(Number(min) || 0));
  const h24 = Math.floor(v / 60) % 24;
  const mm = String(v % 60).padStart(2, '0');
  const suffix = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mm}${suffix}`;
}

export function dayName(idx, short = false) {
  const name = DAY_NAMES[idx] ?? '?';
  return short ? name.slice(0, 3) : name;
}

/** One meeting as 'Mon 8:30am · C-101'. */
export function meetingLabel(m) {
  const bits = [`${dayName(m.dayIdx, true)} ${minutesToTime(m.startMin)}`];
  if (m.room) bits.push(m.room);
  return bits.join(' · ');
}

/** Change vs a previous period: { text: '+3 vs last week', dir: 'up'|'down'|'flat' }. */
export function delta(current, previous, period = 'last week') {
  const diff = (Number(current) || 0) - (Number(previous) || 0);
  if (diff === 0) return { text: `Same as ${period}`, dir: 'flat' };
  return { text: `${diff > 0 ? '+' : '−'}${formatNumber(Math.abs(diff))} vs ${period}`, dir: diff > 0 ? 'up' : 'down' };
}

export function initials(name, email = '') {
  const source = (name || '').trim() || (email || '').split('@')[0];
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
  return letters.toUpperCase();
}

export function percent(part, whole) {
  const w = Number(whole) || 0;
  return w ? Math.round(((Number(part) || 0) / w) * 100) : 0;
}

export const STATUS_LABEL = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', disabled: 'Disabled' };
export const STATUS_TONE = { pending: 'warn', approved: 'ok', rejected: 'bad', disabled: 'off' };
export const ROLE_LABEL = { student: 'Student', admin: 'Admin' };
export const SOURCE_LABEL = { signup: 'Signed Up', preadded: 'Pre-Added' };

const ACTION_LABEL = {
  'user.approve': 'Approved User',
  'user.reject': 'Rejected User',
  'user.disable': 'Disabled User',
  'user.reset': 'Reset To Pending',
  'user.update': 'Updated User',
  'user.role': 'Changed Role',
  'user.rename': 'Renamed User',
  'user.preadd': 'Pre-Added User',
  'timetable.upload': 'Uploaded Timetable',
  'timetable.publish': 'Published Timetable',
  'timetable.unpublish': 'Unpublished Timetable',
  'timetable.edit': 'Edited Timetable',
  'timetable.delete': 'Deleted Timetable',
  'room.create': 'Created Room Account',
  'room.update': 'Updated Room Account',
  'room.delete': 'Deleted Room Account',
};

/** 'user.approve' -> 'Approved User'; unknown actions get a readable fallback. */
export function actionLabel(action) {
  if (ACTION_LABEL[action]) return ACTION_LABEL[action];
  return String(action || '')
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** Tone for an action badge / feed dot. */
export function actionTone(action) {
  if (/\.(delete|reject|disable)$/.test(action)) return 'bad';
  if (/\.(approve|publish|preadd|create|upload)$/.test(action)) return 'ok';
  return 'info';
}

/** Round an axis maximum up to a clean value; returns { max, step }. */
export function niceScale(maxValue, targetTicks = 4) {
  const m = Math.max(0, Number(maxValue) || 0);
  if (m === 0) return { max: 4, step: 1 };
  // Smallest 1-2-5 step (never fractional: these are counts) that needs at most
  // targetTicks + 1 intervals.
  for (let mag = 1; ; mag *= 10) {
    for (const f of [1, 2, 5]) {
      const step = f * mag;
      if (Math.ceil(m / step) <= targetTicks + 1) return { max: Math.ceil(m / step) * step, step };
    }
  }
}
