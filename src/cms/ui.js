// DOM helpers for the CMS. Everything that comes from the API is inserted as
// text (h() turns strings into text nodes); the only markup built from strings
// is the static icon set below.

import { apiFetch } from '../auth-client.js';

// ---------------------------------------------------------------- icons (Lucide paths)

const ICONS = {
  dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  chart: '<path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  door: '<path d="M13 4h3a2 2 0 0 1 2 2v14"/><path d="M2 20h3"/><path d="M13 20h9"/><path d="M10 12v.01"/><path d="M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561Z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  pulse: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
};

export function icon(name, size = 18) {
  const span = document.createElement('span');
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  return span.firstChild;
}

// ---------------------------------------------------------------- elements

/**
 * h('div', { class: 'x', onClick: fn, dataset: {...}, 'aria-label': '...' }, child, 'text', ...)
 * Strings and numbers become text nodes; null/false children are skipped.
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function button(label, { icon: ic, variant = 'light', size = 'sm', onClick, type = 'button', title, disabled, ariaLabel } = {}) {
  return h(
    'button',
    { type, class: `btn btn--${variant} btn--${size}`, onClick, title, disabled, 'aria-label': ariaLabel },
    ic ? icon(ic, size === 'xs' ? 14 : 16) : null,
    label,
  );
}

export function linkButton(label, href, { icon: ic, variant = 'light', size = 'sm', external = false } = {}) {
  return h(
    'a',
    { class: `btn btn--${variant} btn--${size}`, href, target: external ? '_blank' : null, rel: external ? 'noopener' : null },
    ic ? icon(ic, 16) : null,
    label,
  );
}

/** Run `fn` with the button showing a spinner; restores it afterwards. */
export async function busy(btn, fn) {
  if (btn.getAttribute('aria-busy') === 'true') return undefined;
  const saved = [...btn.childNodes];
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ...saved.filter((n) => n.nodeType === 3));
  try {
    return await fn();
  } finally {
    if (btn.isConnected) {
      btn.replaceChildren(...saved);
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
  }
}

export function badge(text, tone = 'info', { plain = false, mono = false } = {}) {
  return h('span', { class: `badge badge--${tone}${plain ? ' badge--plain' : ''}${mono ? ' badge--mono' : ''}` }, text);
}

export function pageHead({ eyebrow, title, description, actions = [], back }) {
  return h(
    'header',
    { class: 'page-head' },
    h(
      'div',
      null,
      back ? h('a', { class: 'back', href: back.href }, icon('back', 16), back.label) : null,
      eyebrow ? h('p', { class: 'eyebrow' }, eyebrow) : null,
      h('h1', { tabindex: '-1', 'data-focus': '' }, title),
      description ? h('p', null, description) : null,
    ),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null,
  );
}

export function card({ title, description, action, body, flush = false, className = '' }) {
  return h(
    'section',
    { class: `card ${className}`.trim() },
    title || action
      ? h('div', { class: 'card-head' }, title ? h('h2', null, title) : h('span'), action || null, description ? h('p', null, description) : null)
      : null,
    h('div', { class: flush ? 'card-body card-body--flush' : 'card-body' }, body),
  );
}

export function statTile({ label, value, unit, sub, icon: ic, alert = false, deltaInfo }) {
  return h(
    'div',
    { class: `card stat${alert ? ' stat--alert' : ''}` },
    h('div', { class: 'stat-top' }, h('span', { class: 'stat-label' }, label), ic ? h('span', { class: 'stat-icon' }, icon(ic, 17)) : null),
    h('div', { class: 'stat-value' }, value, unit ? h('small', null, ` ${unit}`) : null),
    deltaInfo || sub
      ? h(
          'div',
          { class: 'stat-sub' },
          deltaInfo ? h('span', { class: `delta delta--${deltaInfo.dir}` }, deltaInfo.text) : null,
          deltaInfo && sub ? ' · ' : null,
          sub || null,
        )
      : null,
  );
}

export function emptyState({ icon: ic = 'layers', title, text, action }) {
  return h(
    'div',
    { class: 'empty' },
    h('span', { class: 'icon-tile' }, icon(ic, 22)),
    title ? h('strong', null, title) : null,
    text ? h('span', null, text) : null,
    action || null,
  );
}

export function errorState(message, onRetry) {
  return h(
    'div',
    { class: 'card state' },
    h('span', { class: 'icon-tile icon-tile--lg' }, icon('alert', 24)),
    h('strong', null, 'This Page Could Not Load'),
    h('p', null, message || 'Something went wrong.'),
    onRetry ? button('Try Again', { icon: 'refresh', variant: 'primary', onClick: onRetry }) : null,
  );
}

export function skeleton(...heights) {
  return h('div', { class: 'grid', 'aria-busy': 'true', 'aria-label': 'Loading' }, heights.map((px) => h('div', { class: 'skeleton', style: `height:${px}px` })));
}

/**
 * Table that collapses into cards on phones.
 * columns: [{ label, className?, main? }]; rows: [[cell, ...]] where a cell is a
 * node / string, or { content, className }.
 */
export function table(columns, rows, { cards = true, caption } = {}) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: `table${cards ? ' table--cards' : ''}` },
      caption ? h('caption', { class: 'visually-hidden' }, caption) : null,
      h('thead', null, h('tr', null, columns.map((c) => h('th', { scope: 'col', class: c.className || null }, c.label)))),
      h(
        'tbody',
        null,
        rows.map((cells) =>
          h(
            'tr',
            null,
            cells.map((cell, i) => {
              const col = columns[i] || {};
              const isObj = cell && typeof cell === 'object' && !(cell instanceof Node) && !Array.isArray(cell);
              const cls = [col.className, col.main ? 'cell-main' : '', isObj ? cell.className : ''].filter(Boolean).join(' ');
              return h('td', { class: cls || null, 'data-label': col.label }, isObj ? cell.content : cell);
            }),
          ),
        ),
      ),
    ),
  );
}

export function titleCell(title, sub, href) {
  return h('div', { class: 'cell-title' }, href ? h('a', { href }, title) : h('strong', null, title), sub ? h('span', null, sub) : null);
}

// ---------------------------------------------------------------- toasts & dialogs

export function toast(message, tone = 'ok') {
  const host = document.getElementById('toasts');
  const el = h('div', { class: `toast toast--${tone}` }, icon(tone === 'bad' ? 'alert' : 'check', 17), message);
  host.append(el);
  setTimeout(() => el.remove(), tone === 'bad' ? 6000 : 3500);
}

/**
 * Modal form. `fields` are nodes placed in the form; `onSubmit(form)` may
 * return a string (shown as an error, dialog stays open) or anything else to
 * close. Resolves with onSubmit's result, or null when cancelled.
 */
export function openDialog({ title, description, fields = [], submitLabel = 'Save', danger = false, cancelLabel = 'Cancel', onSubmit, hideCancel = false }) {
  return new Promise((resolve) => {
    const error = h('div', { class: 'alert', role: 'alert', hidden: true });
    const submit = h('button', { type: 'submit', class: `btn ${danger ? 'btn--danger-solid' : 'btn--primary'} btn--sm` }, submitLabel);
    const cancel = hideCancel ? null : h('button', { type: 'button', class: 'btn btn--light btn--sm', value: 'cancel' }, cancelLabel);
    const form = h(
      'form',
      { class: 'modal-form', method: 'dialog', novalidate: true },
      h(
        'div',
        { class: 'modal-head' },
        h('div', null, h('h2', null, title), description ? h('p', null, description) : null),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', value: 'cancel' }, icon('x', 18)),
      ),
      fields.length ? h('div', { class: 'fields' }, fields) : null,
      error,
      h('div', { class: 'modal-foot' }, cancel, submit),
    );
    const dialog = h('dialog', { class: 'modal' }, form);
    let result = null;

    form.addEventListener('click', (e) => {
      const b = e.target.closest('button[value="cancel"]');
      if (b) dialog.close();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.hidden = true;
      const out = await busy(submit, async () => (onSubmit ? onSubmit(form) : true));
      if (typeof out === 'string') {
        error.textContent = out;
        error.hidden = false;
        return;
      }
      result = out ?? true;
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    const first = form.querySelector('input, select, textarea');
    (first || submit).focus();
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return openDialog({
    title,
    description: message,
    submitLabel: confirmLabel,
    danger,
    onSubmit: () => true,
  }).then(Boolean);
}

export function field(label, control, hint) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
}

export function input(attrs = {}) {
  return h('input', { class: 'input', ...attrs });
}

export function select(options, value, attrs = {}) {
  return h(
    'select',
    { class: 'select', ...attrs },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)),
  );
}

// ---------------------------------------------------------------- API

/**
 * apiFetch plus the CMS's session handling: a signed-out or demoted admin is
 * sent away instead of seeing a broken page.
 */
export async function api(path, init) {
  const res = await apiFetch(path, init);
  if (!res.ok && res.status === 401) {
    location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.hash)}`);
  } else if (!res.ok && res.status === 403 && ['NOT_ADMIN', 'NOT_APPROVED', 'ACCOUNT_REVOKED'].includes(res.error?.code)) {
    location.replace(res.error.code === 'NOT_ADMIN' ? '/app.html' : '/pending.html');
  }
  return res;
}
