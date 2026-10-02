// Draws the weekly schedule onto a 2D canvas context. Used for the on-page
// preview and, at a higher scale, for the PNG export.

import { WEEKDAYS, fmtHourLabel, fmtMinutes, computeGrid, assignOverlapSlices, labelColorOn } from './model.js';

const CANVAS_BG = '#fcfcfb';
const CANVAS_GRIDLINE = '#e1e0d9';
const CANVAS_INK = '#0b0b0b';
const CANVAS_MUTED = '#898781';
const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';

const LAYOUT = {
  pad: 18,
  gutterW: 56,
  headerH: 36,
  hourH: 64,
  colW: 164,
  titleH: 26,
};

function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) {
    s = s.slice(0, -1);
  }
  return s + '…';
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * @param ctx     2D context (its canvas is resized to fit)
 * @param scale   device-pixel multiplier
 * @param view    { meta: { department, semester } | null,
 *                  events: from selectedEvents(),
 *                  colorFor: (section) => hex }
 */
export function renderTimetable(ctx, scale, view) {
  const { meta, events, colorFor } = view;
  const grid = computeGrid(events);
  const L = LAYOUT;

  const titleParts = [];
  if (meta) {
    if (meta.department) titleParts.push(meta.department);
    if (meta.semester) titleParts.push(meta.semester);
  }
  const title = titleParts.join(' - ');
  const titleH = title ? L.titleH : 0;

  const gridW = grid.dayIdxs.length * L.colW;
  const gridH = (grid.endHour - grid.startHour) * L.hourH;
  const width = L.pad + L.gutterW + gridW + L.pad;
  const height = L.pad + titleH + L.headerH + gridH + L.pad;

  ctx.canvas.width = Math.round(width * scale);
  ctx.canvas.height = Math.round(height * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  ctx.fillStyle = CANVAS_BG;
  ctx.fillRect(0, 0, width, height);

  const gx = L.pad + L.gutterW;
  const gy = L.pad + titleH + L.headerH;

  if (title) {
    ctx.fillStyle = CANVAS_INK;
    ctx.font = '600 13px ' + FONT_STACK;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(title, L.pad, L.pad + 14);
  }

  ctx.fillStyle = CANVAS_INK;
  ctx.font = '700 13px ' + FONT_STACK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  grid.dayIdxs.forEach((dayIdx, i) => {
    ctx.fillText(WEEKDAYS[dayIdx], gx + i * L.colW + L.colW / 2, gy - L.headerH / 2);
  });

  for (let hour = grid.startHour; hour <= grid.endHour; hour++) {
    const y = gy + (hour - grid.startHour) * L.hourH;
    ctx.strokeStyle = CANVAS_GRIDLINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gx, y + 0.5);
    ctx.lineTo(gx + gridW, y + 0.5);
    ctx.stroke();

    ctx.fillStyle = CANVAS_MUTED;
    ctx.font = '11px ' + FONT_STACK;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtHourLabel(hour), gx - 8, y);

    if (hour < grid.endHour) {
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(gx, y + L.hourH / 2 + 0.5);
      ctx.lineTo(gx + gridW, y + L.hourH / 2 + 0.5);
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.strokeStyle = CANVAS_GRIDLINE;
  for (let d = 0; d <= grid.dayIdxs.length; d++) {
    const x = gx + d * L.colW;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, gy);
    ctx.lineTo(x + 0.5, gy + gridH);
    ctx.stroke();
  }

  if (!events.length) {
    ctx.fillStyle = CANVAS_MUTED;
    ctx.font = '13px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Add sections in step 2 to see your schedule here.', gx + gridW / 2, gy + gridH / 2);
    return;
  }

  grid.dayIdxs.forEach((dayIdx, colIdx) => {
    const dayEvents = events.filter((ev) => ev.dayIdx === dayIdx);
    if (!dayEvents.length) return;
    assignOverlapSlices(dayEvents);

    dayEvents.forEach((ev) => {
      const sliceW = (L.colW - 4) / ev._sliceCount;
      const x = gx + colIdx * L.colW + 2 + ev._slice * sliceW + 1;
      const w = sliceW - 2;
      const y = gy + (ev.start - grid.startHour * 60) / 60 * L.hourH + 1;
      const h = (ev.end - ev.start) / 60 * L.hourH - 2;

      const fill = colorFor(ev.sec);
      roundRectPath(ctx, x, y, w, h, 6);
      ctx.fillStyle = fill;
      ctx.fill();

      ctx.save();
      roundRectPath(ctx, x, y, w, h, 6);
      ctx.clip();
      ctx.fillStyle = labelColorOn(fill, CANVAS_INK);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';

      const innerX = x + 8;
      const innerW = w - 16;
      let cursorY = y + 7;
      const lines = [
        {
          text: (ev.sec.code === ev.sec.name ? '' : ev.sec.code + ' · ') + ev.sec.section,
          font: '700 12px ' + FONT_STACK, lh: 15,
        },
        { text: ev.meeting.room, font: '11px ' + FONT_STACK, lh: 14 },
        { text: ev.sec.teacher, font: '11px ' + FONT_STACK, lh: 14 },
        { text: ev.sec.name, font: 'italic 10.5px ' + FONT_STACK, lh: 13 },
        { text: fmtMinutes(ev.start) + '–' + fmtMinutes(ev.end), font: '10.5px ' + FONT_STACK, lh: 13 },
      ];
      lines.forEach((line) => {
        if (!line.text) return;
        if (cursorY + line.lh > y + h - 4) return; // no room: drop the lower-priority lines
        ctx.font = line.font;
        ctx.fillText(ellipsize(ctx, line.text, innerW), innerX, cursorY + line.lh - 3);
        cursorY += line.lh;
      });
      ctx.restore();
    });
  });
}
