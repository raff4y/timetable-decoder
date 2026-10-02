// Activity Log: every admin change (user approvals and roles, timetable
// uploads/publishes/edits/deletes, Room Finder accounts), searchable and paged.
// GET /api/admin/activity?q=&action=&page=

import { api, badge, button, card, clear, emptyState, errorState, h, icon, input, pageHead, select, skeleton } from '../ui.js';
import { actionLabel, actionTone, formatDateTime, formatNumber, timeAgo } from '../format.js';

const GROUPS = [
  ['user', 'All User Changes'],
  ['timetable', 'All Timetable Changes'],
  ['room', 'All Room Finder Changes'],
];

export async function render(ctx) {
  const q = ctx.route.query;
  const state = { q: q.get('q') || '', action: q.get('action') || '', page: Math.max(1, Number(q.get('page')) || 1) };
  const search = input({ type: 'search', class: 'input input--sm', placeholder: 'Search changes or people', value: state.q, 'aria-label': 'Search activity' });
  const actionHost = h('span');
  const host = h('div');
  ctx.view.append(
    pageHead({
      eyebrow: 'Insights',
      title: 'Activity Log',
      description: 'Every change made by an admin: who did it, when, and what changed.',
    }),
    h('div', { class: 'filters' }, h('div', { class: 'search grow' }, icon('search', 16), search), actionHost),
    host,
  );
  host.append(skeleton(420));

  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = search.value.trim();
      state.page = 1;
      load();
    }, 250);
  });

  async function load() {
    ctx.setQuery({ q: state.q, action: state.action, page: state.page > 1 ? String(state.page) : '' });
    host.classList.add('is-refreshing');
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.action) params.set('action', state.action);
    params.set('page', String(state.page));
    const res = await api(`/admin/activity?${params}`);
    if (!ctx.isCurrent()) return;
    host.classList.remove('is-refreshing');
    if (!res.ok) {
      clear(host, errorState(res.error.message, load));
      return;
    }
    drawFilter(res.data.actions);
    draw(res.data);
  }

  function drawFilter(actions) {
    const options = [['', 'All Changes'], ...GROUPS, ...actions.map((a) => [a.action, `${actionLabel(a.action)} (${formatNumber(a.count)})`])];
    if (state.action && !options.some(([v]) => v === state.action)) options.push([state.action, actionLabel(state.action)]);
    const sel = select(options, state.action, { 'aria-label': 'Filter by change type' });
    sel.addEventListener('change', () => {
      state.action = sel.value;
      state.page = 1;
      load();
    });
    clear(actionHost, sel);
  }

  function draw(d) {
    if (!d.entries.length) {
      clear(host, card({ body: emptyState({ icon: 'history', title: d.total || state.q || state.action ? 'No Matching Changes' : 'No Changes Yet', text: state.q || state.action ? 'Try a different search or filter.' : 'Admin changes are recorded from now on.' }) }));
      return;
    }
    const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    const from = (d.page - 1) * d.pageSize + 1;
    const to = from + d.entries.length - 1;
    const prev = button('Newer', { icon: 'back', size: 'xs', disabled: d.page <= 1, onClick: () => { state.page--; load(); } });
    const next = button('Older', { size: 'xs', disabled: d.page >= pages, onClick: () => { state.page++; load(); } });
    clear(
      host,
      card({
        flush: true,
        body: [
          h('ul', { class: 'list' }, d.entries.map(entry)),
          h('div', { class: 'pager' }, h('span', null, `${formatNumber(from)}–${formatNumber(to)} of ${formatNumber(d.total)}`), h('div', { class: 'row-actions' }, prev, next)),
        ],
      }),
    );
  }

  await load();
}

function entry(e) {
  const changes = e.details && typeof e.details === 'object' ? e.details : {};
  const diffs = Object.entries(changes).filter(([, v]) => v && typeof v === 'object' && 'from' in v && 'to' in v);
  const extra = Object.entries(changes).filter(([, v]) => v === null || typeof v !== 'object');
  const hasDetails = diffs.length || extra.length;
  const detailsEl = hasDetails
    ? h(
        'dl',
        { class: 'changes', hidden: true },
        diffs.map(([k, v]) => [h('dt', null, label(k)), h('dd', null, h('del', null, show(v.from)), ' → ', h('ins', null, show(v.to)))]),
        extra.map(([k, v]) => [h('dt', null, label(k)), h('dd', null, show(v))]),
      )
    : null;
  const toggle = hasDetails
    ? h('button', { type: 'button', class: 'text-btn details-toggle', 'aria-expanded': 'false' }, 'Show Details')
    : null;
  toggle?.addEventListener('click', () => {
    const open = detailsEl.hidden;
    detailsEl.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Hide Details' : 'Show Details';
  });
  return h(
    'li',
    { class: 'feed-item' },
    h('span', { class: `feed-dot feed-dot--${actionTone(e.action)}`, 'aria-hidden': 'true' }, icon(e.targetType === 'timetable' ? 'calendar' : e.targetType === 'room' ? 'door' : 'users', 15)),
    h(
      'div',
      { class: 'grow' },
      h('div', { class: 'feed-text' }, e.summary || actionLabel(e.action)),
      h(
        'div',
        { class: 'feed-meta' },
        badge(actionLabel(e.action), actionTone(e.action), { plain: true }),
        ` ${e.actorName || e.actorEmail || 'System'} · `,
        h('time', { datetime: e.createdAt, title: formatDateTime(e.createdAt) }, timeAgo(e.createdAt)),
        e.targetType === 'timetable' && !/\.delete$/.test(e.action) && e.targetId ? [' · ', h('a', { href: `#/timetables/${e.targetId}` }, 'Open Timetable')] : null,
      ),
      toggle,
      detailsEl,
    ),
  );
}

function label(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function show(v) {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
