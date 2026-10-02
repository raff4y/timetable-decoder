// Small SVG charts for the CMS, built by hand (no chart library dependency).
// Every chart here is single-series, so one mark color (brand 600, which clears
// 3:1 on white) and no legend: the card title names the series. Marks follow
// the house specs: columns <= 24px with a 4px rounded data end, 2px lines,
// recessive 1px gridlines, a tooltip on hover/focus, and a table view.

import { h } from './ui.js';
import { formatNumber, niceScale } from './format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD = { top: 14, right: 12, bottom: 26, left: 34 };

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** Column path with a rounded top (data end) and a square baseline. */
function columnPath(x, y, w, hgt, r = 4) {
  if (hgt <= 0) return '';
  const rr = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
}

function tableView(caption, columns, rows) {
  return h(
    'details',
    { class: 'chart-table' },
    h('summary', null, 'View As Table'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'table' },
        h('caption', { class: 'visually-hidden' }, caption),
        h('thead', null, h('tr', null, columns.map((c, i) => h('th', { scope: 'col', class: i ? 'num' : null }, c)))),
        h('tbody', null, rows.map((r) => h('tr', null, r.map((v, i) => h('td', { class: i ? 'num' : null }, v))))),
      ),
    ),
  );
}

/** Re-render on width changes; returns the wrapper element. */
function responsive(draw) {
  const wrap = h('div', { class: 'chart' });
  let lastWidth = 0;
  const render = () => {
    const width = Math.round(wrap.clientWidth);
    if (!width || width === lastWidth) return;
    lastWidth = width;
    draw(wrap, width);
  };
  // Redraw on the next frame, not inside the observer callback, so a redraw
  // that nudges layout can't trigger a ResizeObserver loop.
  let frame = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(render);
  });
  ro.observe(wrap);
  // Disconnect once the chart leaves the page (screen change).
  const mo = new MutationObserver(() => {
    if (!wrap.isConnected) {
      ro.disconnect();
      mo.disconnect();
    }
  });
  queueMicrotask(() => mo.observe(document.body, { childList: true, subtree: true }));
  return wrap;
}

function axis(svg, { width, height, max, step }) {
  const innerH = height - PAD.top - PAD.bottom;
  for (let v = 0; v <= max; v += step) {
    const y = PAD.top + innerH - (v / max) * innerH;
    svg.append(s('line', { class: v === 0 ? 'baseline' : 'gridline', x1: PAD.left, x2: width - PAD.right, y1: y, y2: y }));
    svg.append(s('text', { class: 'tick', x: PAD.left - 8, y: y + 4, 'text-anchor': 'end' }, formatNumber(v)));
  }
}

function tooltip(wrap) {
  const tip = h('div', { class: 'chart-tip', hidden: true });
  wrap.append(tip);
  return {
    show(x, y, value, label) {
      tip.replaceChildren(h('strong', null, value), h('span', null, label));
      tip.hidden = false;
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(Math.max(x, half), wrap.clientWidth - half)}px`;
      tip.style.top = `${y}px`;
    },
    hide() {
      tip.hidden = true;
    },
  };
}

/** Pick which x labels to print so they never collide. */
function labelStride(count, innerW, minGap = 46) {
  return Math.max(1, Math.ceil(count / Math.max(1, Math.floor(innerW / minGap))));
}

/** Labels are counted back from the last point, so the newest is always labelled. */
function showLabel(i, count, stride) {
  return (count - 1 - i) % stride === 0;
}

/**
 * Column chart. data: [{ label, tipLabel?, value }].
 * opts: { height, unit ('sign-ups'), caption, firstColumn }
 */
export function columnChart(data, { height = 200, unit = '', caption = '', firstColumn = 'Day' } = {}) {
  const fig = h('figure', { style: 'margin:0' });
  if (!data.length || data.every((d) => !d.value)) {
    fig.append(h('div', { class: 'chart-empty' }, 'Nothing To Show Yet'));
  }
  const chart = responsive((wrap, width) => {
    wrap.replaceChildren();
    const { max, step } = niceScale(Math.max(...data.map((d) => d.value)));
    const innerW = width - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;
    const slot = innerW / data.length;
    const barW = Math.max(2, Math.min(24, slot - 2)); // 2px surface gap between neighbours
    const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': caption });
    axis(svg, { width, height, max, step });
    const tip = tooltip(wrap);
    const stride = labelStride(data.length, innerW);

    data.forEach((d, i) => {
      const x0 = PAD.left + i * slot;
      const bh = (d.value / max) * innerH;
      const g = s('g', { class: 'slot' });
      g.append(s('rect', { class: 'hitbg', x: x0, y: PAD.top, width: slot, height: innerH }));
      if (bh > 0) g.append(s('path', { class: 'bar', d: columnPath(x0 + (slot - barW) / 2, PAD.top + innerH - bh, barW, bh) }));
      const hit = s('rect', {
        class: 'hit', x: x0, y: PAD.top, width: slot, height: innerH + PAD.bottom, tabindex: 0,
        'aria-label': `${d.tipLabel || d.label}: ${formatNumber(d.value)} ${unit}`.trim(),
      });
      const on = () => {
        g.classList.add('active');
        tip.show(x0 + slot / 2, PAD.top + innerH - bh, `${formatNumber(d.value)} ${unit}`.trim(), d.tipLabel || d.label);
      };
      const off = () => {
        g.classList.remove('active');
        tip.hide();
      };
      hit.addEventListener('pointerenter', on);
      hit.addEventListener('pointerleave', off);
      hit.addEventListener('focus', on);
      hit.addEventListener('blur', off);
      g.append(hit);
      svg.append(g);
      if (showLabel(i, data.length, stride)) {
        svg.append(s('text', { class: 'tick', x: x0 + slot / 2, y: height - 8, 'text-anchor': 'middle' }, d.label));
      }
    });
    wrap.prepend(svg);
  });
  if (!(data.length && data.every((d) => !d.value))) fig.append(chart);
  fig.append(tableView(caption, [firstColumn, unit ? unit[0].toUpperCase() + unit.slice(1) : 'Value'], data.map((d) => [d.tipLabel || d.label, formatNumber(d.value)])));
  return fig;
}

/**
 * Line chart with an area wash, a snapping crosshair and an end label.
 * data: [{ label, tipLabel?, value }].
 */
export function lineChart(data, { height = 200, unit = '', caption = '', firstColumn = 'Day' } = {}) {
  const fig = h('figure', { style: 'margin:0' });
  const empty = !data.length || data.every((d) => !d.value);
  if (empty) fig.append(h('div', { class: 'chart-empty' }, 'Nothing To Show Yet'));
  const chart = responsive((wrap, width) => {
    wrap.replaceChildren();
    const { max, step } = niceScale(Math.max(...data.map((d) => d.value)));
    const right = PAD.right + 18; // room for the end label
    const innerW = width - PAD.left - right;
    const innerH = height - PAD.top - PAD.bottom;
    const xAt = (i) => PAD.left + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
    const yAt = (v) => PAD.top + innerH - (v / max) * innerH;
    const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': caption });
    axis(svg, { width: width - 18, height, max, step });

    const pts = data.map((d, i) => [xAt(i), yAt(d.value)]);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join('');
    svg.append(s('path', { class: 'area', d: `${line}L${pts.at(-1)[0]},${yAt(0)}L${pts[0][0]},${yAt(0)}Z` }));
    svg.append(s('path', { class: 'line', d: line }));
    const [ex, ey] = pts.at(-1);
    svg.append(s('circle', { class: 'dot', cx: ex, cy: ey, r: 4 }));
    svg.append(s('text', { class: 'end-label', x: ex + 8, y: ey + 4 }, formatNumber(data.at(-1).value)));

    const stride = labelStride(data.length, innerW);
    data.forEach((d, i) => {
      if (showLabel(i, data.length, stride)) {
        svg.append(s('text', { class: 'tick', x: xAt(i), y: height - 8, 'text-anchor': 'middle' }, d.label));
      }
    });

    const cross = s('line', { class: 'crosshair', y1: PAD.top, y2: PAD.top + innerH, visibility: 'hidden' });
    const hover = s('circle', { class: 'dot', r: 4, visibility: 'hidden' });
    svg.append(cross, hover);
    const tip = tooltip(wrap);
    const hit = s('rect', {
      class: 'hit', x: PAD.left - 6, y: PAD.top, width: innerW + 12, height: innerH, tabindex: 0,
      'aria-label': `${caption}. Use the arrow keys to read values.`,
    });
    let idx = data.length - 1;
    const showAt = (i) => {
      idx = Math.max(0, Math.min(data.length - 1, i));
      const [x, y] = pts[idx];
      cross.setAttribute('x1', x);
      cross.setAttribute('x2', x);
      cross.setAttribute('visibility', 'visible');
      hover.setAttribute('cx', x);
      hover.setAttribute('cy', y);
      hover.setAttribute('visibility', 'visible');
      tip.show(x, y, `${formatNumber(data[idx].value)} ${unit}`.trim(), data[idx].tipLabel || data[idx].label);
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      hover.setAttribute('visibility', 'hidden');
      tip.hide();
    };
    hit.addEventListener('pointermove', (e) => {
      const box = svg.getBoundingClientRect();
      const x = e.clientX - box.left;
      const i = data.length === 1 ? 0 : Math.round(((x - PAD.left) / innerW) * (data.length - 1));
      showAt(i);
    });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', () => showAt(idx));
    hit.addEventListener('blur', hide);
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        showAt(idx + (e.key === 'ArrowRight' ? 1 : -1));
      }
    });
    svg.append(hit);
    wrap.prepend(svg);
  });
  if (!empty) fig.append(chart);
  fig.append(tableView(caption, [firstColumn, unit ? unit[0].toUpperCase() + unit.slice(1) : 'Value'], data.map((d) => [d.tipLabel || d.label, formatNumber(d.value)])));
  return fig;
}

/**
 * Ranked horizontal bars (HTML). rows: [{ label, sub?, value, href? }].
 * Values print at the bar end, so no tooltip is needed.
 */
export function barList(rows, { max, unit = '' } = {}) {
  if (!rows.length) return h('div', { class: 'chart-empty' }, 'Nothing To Show Yet');
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return h(
    'ul',
    { class: 'bars' },
    rows.map((r) =>
      h(
        'li',
        { class: 'bar-row' },
        h(
          'span',
          { class: 'bar-label', title: r.sub ? `${r.label} · ${r.sub}` : r.label },
          r.href ? h('a', { href: r.href }, r.label) : r.label,
          r.sub ? h('span', null, ` · ${r.sub}`) : null,
        ),
        h('span', { class: 'bar-value' }, `${formatNumber(r.value)}${unit ? ` ${unit}` : ''}`),
        h(
          'span',
          { class: 'bar-track', 'aria-hidden': 'true' },
          h('span', { class: 'bar-fill', style: `width:${Math.max(0, Math.min(100, (r.value / top) * 100))}%` }),
        ),
      ),
    ),
  );
}
