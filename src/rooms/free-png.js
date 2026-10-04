// Draws a room's free slots as a shareable PNG: one column per chosen day, a
// shared time axis down the left, free stretches as green blocks and everything
// else (booked, or too short to use) left grey. Always light-themed so the image
// reads the same wherever it gets pasted.

import { WEEKDAYS, fmtMinutes } from '../../server/parser/time.js';
import { fmtSpan } from './free-slots.js';

const SCALE = 2; // render at 2x so text stays sharp when the image is zoomed or printed
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const C = {
  bg: '#ffffff',
  text: '#0f172a',
  muted: '#64748b',
  grid: '#e2e8f0',
  busy: '#eef1f5',
  free: '#bbf7d0',
  freeEdge: '#16a34a',
  freeText: '#14532d',
};

const PAD = 24;
const AXIS = 62;
const HEAD = 104;
const DAY_HEAD = 30;
const GAP = 8;
const PX_PER_MIN = 0.9;
const MIN_WIDTH = 400;

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** meta = { roomLabel, where, result, from, to, minGap } (the same object formatText takes). */
export function renderFreeSlotsPng({ roomLabel, where, result, from, to, minGap }) {
  const days = result.days;
  const n = days.length;
  const colW = n <= 2 ? 200 : 150;
  const gridH = Math.round((to - from) * PX_PER_MIN);
  const footer = result.estimated ? 44 : 30;
  const width = Math.max(MIN_WIDTH, PAD * 2 + AXIS + n * colW + (n - 1) * GAP);
  const height = HEAD + DAY_HEAD + gridH + footer + PAD;

  const canvas = document.createElement('canvas');
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'alphabetic';

  // Header
  ctx.fillStyle = C.text;
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText(roomLabel, PAD, PAD + 22);
  ctx.fillStyle = C.muted;
  ctx.font = `500 13px ${FONT}`;
  const sub = [where, `${fmtMinutes(from)} - ${fmtMinutes(to)}`, minGap ? `gaps of ${fmtSpan(minGap)}+` : '']
    .filter(Boolean).join('  ·  ');
  ctx.fillText(sub, PAD, PAD + 44);

  // Legend
  const ly = PAD + 62;
  ctx.fillStyle = C.free;
  roundRect(ctx, PAD, ly, 14, 14, 3); ctx.fill();
  ctx.strokeStyle = C.freeEdge; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = C.text; ctx.font = `500 12px ${FONT}`;
  ctx.fillText('Free', PAD + 20, ly + 11);
  ctx.fillStyle = C.busy;
  roundRect(ctx, PAD + 62, ly, 14, 14, 3); ctx.fill();
  ctx.strokeStyle = C.grid; ctx.stroke();
  ctx.fillStyle = C.text;
  ctx.fillText('Booked', PAD + 82, ly + 11);

  const gridTop = HEAD + DAY_HEAD;
  const yOf = (min) => gridTop + (min - from) * PX_PER_MIN;
  const gridLeft = PAD + AXIS;

  // Hour lines and labels
  ctx.font = `500 11px ${FONT}`;
  for (let t = Math.ceil(from / 60) * 60; t <= to; t += 60) {
    const y = Math.round(yOf(t)) + 0.5;
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(gridLeft - 6, y); ctx.lineTo(width - PAD, y); ctx.stroke();
    ctx.fillStyle = C.muted; ctx.textAlign = 'right';
    ctx.fillText(fmtMinutes(t), gridLeft - 10, y + 4);
  }
  ctx.textAlign = 'left';

  // Day columns
  const colsW = width - PAD * 2 - AXIS;
  const cw = (colsW - (n - 1) * GAP) / n;
  days.forEach(({ dayIdx, slots }, i) => {
    const x = gridLeft + i * (cw + GAP);

    ctx.fillStyle = C.text; ctx.font = `700 13px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillText(WEEKDAYS[dayIdx], x + cw / 2, HEAD + 20);
    ctx.textAlign = 'left';

    ctx.fillStyle = C.busy;
    roundRect(ctx, x, gridTop, cw, gridH, 8); ctx.fill();

    if (!slots.length) {
      ctx.fillStyle = C.muted; ctx.font = `500 12px ${FONT}`; ctx.textAlign = 'center';
      ctx.fillText('No free slots', x + cw / 2, gridTop + gridH / 2);
      ctx.textAlign = 'left';
      return;
    }

    slots.forEach((s) => {
      const y = yOf(s.startMin);
      const h = (s.endMin - s.startMin) * PX_PER_MIN;
      ctx.fillStyle = C.free;
      roundRect(ctx, x + 3, y + 1, cw - 6, h - 2, 6); ctx.fill();
      ctx.strokeStyle = C.freeEdge; ctx.lineWidth = 1.25; ctx.stroke();

      if (h < 26) return; // too short to hold a label; the colour still shows it
      ctx.textAlign = 'center';
      ctx.fillStyle = C.freeText;
      const allDay = s.startMin === from && s.endMin === to;
      const range = `${fmtMinutes(s.startMin)} - ${fmtMinutes(s.endMin)}`;
      if (h >= 46) {
        const cy = y + h / 2;
        ctx.font = `700 11.5px ${FONT}`;
        ctx.fillText(allDay ? 'Free all day' : range, x + cw / 2, cy - 1);
        ctx.font = `500 11px ${FONT}`;
        ctx.fillText(allDay ? range : fmtSpan(s.minutes), x + cw / 2, cy + 13);
      } else {
        ctx.font = `700 11px ${FONT}`;
        ctx.fillText(range, x + cw / 2, y + h / 2 + 4);
      }
      ctx.textAlign = 'left';
    });
  });

  // Footer
  ctx.fillStyle = C.muted; ctx.font = `500 11px ${FONT}`;
  const fy = gridTop + gridH + 20;
  ctx.fillText('Free Room Finder', PAD, fy);
  if (result.estimated) {
    ctx.fillText('Some class lengths are estimated (the timetable lists only a start time).', PAD, fy + 15);
  }
  return canvas;
}
