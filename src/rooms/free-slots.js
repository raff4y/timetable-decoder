// Free-slot export for one room. Pure functions: no DOM, no globals, so the
// Room Finder page and the tests share them.
//
// A booking is { dayIdx, startMin, endMin, estimated? } (0 = Monday); the page
// builds them from the published timetables (see rebuildIndex in pages/app.js).

import { WEEKDAYS, fmtMinutes } from '../../server/parser/time.js';

export const TEACHING_DAYS = 6; // Monday - Saturday, the days the finder lets you pick

// Nothing after 5:30 pm is ever offered as a free slot, whatever window is asked for.
export const FREE_SLOT_CUTOFF = 17 * 60 + 30;

/** Days a scope covers: 'day' -> [dayIdx], 'week' -> Mon-Sat, 'days' -> the chosen set. */
export function daysForScope(scope, { day = 0, days = [] } = {}) {
  if (scope === 'week') return Array.from({ length: TEACHING_DAYS }, (_, i) => i);
  if (scope === 'days') return [...new Set(days)].filter((d) => d >= 0 && d < TEACHING_DAYS).sort((a, b) => a - b);
  return [day];
}

/**
 * The stretches of one day inside [from, to) not covered by any booking and at
 * least `minGap` minutes long. Overlapping and back-to-back bookings are merged
 * first, so two classes that touch leave no gap between them.
 */
export function freeSlotsForDay(bookings, dayIdx, from, to, minGap = 0) {
  const busy = bookings
    .filter((b) => b.dayIdx === dayIdx && b.endMin > from && b.startMin < to)
    .map((b) => [Math.max(b.startMin, from), Math.min(b.endMin, to)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const slots = [];
  let cursor = from;
  const push = (start, end) => {
    if (end - start > 0 && end - start >= minGap) slots.push({ startMin: start, endMin: end, minutes: end - start });
  };
  for (const [start, end] of busy) {
    if (start > cursor) push(cursor, start);
    if (end > cursor) cursor = end;
  }
  if (cursor < to) push(cursor, to);
  return slots;
}

/** { days: [{ dayIdx, slots }], estimated, from, to } for the chosen days; `to` is capped at FREE_SLOT_CUTOFF. */
export function buildFreeSlots(bookings, { days, from, to, minGap = 0 }) {
  const picked = new Set(days);
  to = Math.min(to, FREE_SLOT_CUTOFF);
  return {
    from,
    to,
    days: days.map((dayIdx) => ({ dayIdx, slots: freeSlotsForDay(bookings, dayIdx, from, to, minGap) })),
    // Some timetables list only a start time; flag the export when any of the
    // classes it was worked out from had a guessed length.
    estimated: bookings.some((b) => picked.has(b.dayIdx) && b.estimated && b.endMin > from && b.startMin < to),
  };
}

/** Teaching hours seen across the rooms, rounded out to whole hours and clamped to [min, max]. */
export function teachingWindow(rooms, min, max) {
  let start = Infinity;
  let end = -Infinity;
  for (const room of rooms) {
    for (const b of room.bookings) {
      if (b.startMin < start) start = b.startMin;
      if (b.endMin > end) end = b.endMin;
    }
  }
  if (!isFinite(start)) return { from: min, to: max };
  return {
    from: Math.max(min, Math.floor(start / 60) * 60),
    to: Math.min(max, FREE_SLOT_CUTOFF, Math.ceil(end / 60) * 60),
  };
}

export function fmtSpan(minutes) {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} hr ${m} min` : `${h} hr`;
  }
  return `${minutes} min`;
}

export function clock24(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

/** Plain-text report, ready to paste into a message. */
export function formatText({ roomLabel, where, result, from, to, minGap }) {
  const lines = [
    `Free time slots - ${roomLabel}${where ? ` (${where})` : ''}`,
    `${fmtMinutes(from)} - ${fmtMinutes(to)}${minGap ? `, gaps of ${fmtSpan(minGap)} or more` : ''}`,
    '',
  ];
  for (const { dayIdx, slots } of result.days) {
    lines.push(WEEKDAYS[dayIdx]);
    if (!slots.length) {
      lines.push('  No free slots');
    } else if (slots.length === 1 && slots[0].startMin === from && slots[0].endMin === to) {
      lines.push(`  Free all day (${fmtMinutes(from)} - ${fmtMinutes(to)})`);
    } else {
      for (const s of slots) lines.push(`  ${fmtMinutes(s.startMin)} - ${fmtMinutes(s.endMin)} (${fmtSpan(s.minutes)})`);
    }
    lines.push('');
  }
  if (result.estimated) {
    lines.push('Note: some timetables give only a start time, so those class lengths are estimated.');
  }
  return lines.join('\n').trimEnd() + '\n';
}
