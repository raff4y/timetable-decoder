// One timetable: GET /api/admin/timetable?id= -> metadata, parser notes,
// stats and every section with how many students saved it.

import {
  api, badge, busy, button, card, clear, emptyState, errorState, h, icon, input, linkButton,
  pageHead, select, skeleton, statTile, table, toast,
} from '../ui.js';
import { formatBytes, formatDateTime, formatNumber, meetingLabel, plural } from '../format.js';
import { deleteTimetable, editTimetable } from './timetables.js';

const PAGE = 150;

export async function render(ctx) {
  const id = ctx.route.parts[1];
  const host = h('div');
  ctx.view.append(host);
  host.append(skeleton(90, 110, 360));

  const res = await api(`/admin/timetable?id=${encodeURIComponent(id)}`);
  if (!ctx.isCurrent()) return;
  if (!res.ok) {
    clear(
      host,
      pageHead({ title: 'Timetable', back: { href: '#/timetables', label: 'All Timetables' } }),
      errorState(res.status === 404 ? 'That timetable doesn’t exist any more. It may have been deleted.' : res.error.message, res.status === 404 ? null : () => render(ctx)),
    );
    return;
  }
  const data = res.data;
  draw(ctx, host, data);
}

function draw(ctx, host, data) {
  const t = data.timetable;
  const st = data.stats;

  const toggle = button(t.isPublished ? 'Unpublish' : 'Publish', { variant: t.isPublished ? 'light' : 'primary', icon: t.isPublished ? 'eyeOff' : 'eye' });
  toggle.addEventListener('click', async () => {
    const res = await busy(toggle, () => api(`/timetables/${t.id}`, { method: 'PATCH', body: { isPublished: !t.isPublished } }));
    if (!res.ok) return toast(res.error.message, 'bad');
    toast(res.data.timetable.isPublished ? 'Published; students can see it now' : 'Unpublished');
    draw(ctx, host, { ...data, timetable: { ...t, ...res.data.timetable } });
  });

  const head = pageHead({
    back: { href: '#/timetables', label: 'All Timetables' },
    eyebrow: [t.department, t.semester].filter(Boolean).join(' · ') || 'Timetable',
    title: t.title || t.fileName || 'Untitled',
    actions: [
      linkButton('Course Demand', `#/demand?t=${t.id}`, { icon: 'chart' }),
      button('Edit', { icon: 'pencil', onClick: () => editTimetable(t, ctx, (u) => draw(ctx, host, { ...data, timetable: { ...t, ...u } })) }),
      button('Delete', { icon: 'trash', variant: 'danger', onClick: () => deleteTimetable({ ...t, schedules: st.schedules }, () => ctx.go('#/timetables')) }),
      toggle,
    ],
  });
  head.querySelector('h1').after(
    h('div', { class: 'row-actions', style: 'margin-top:8px' }, badge(t.isPublished ? 'Published' : 'Draft', t.isPublished ? 'ok' : 'off'), badge(t.template === 'grid' ? 'Period Grid' : 'Flat List', 'info', { plain: true })),
  );

  const parts = [
    head,
    h(
      'div',
      { class: 'grid grid--4' },
      statTile({ label: 'Sections', value: formatNumber(st.sections), icon: 'layers', sub: `${plural(st.courses, 'course')}` }),
      statTile({ label: 'Classes Per Week', value: formatNumber(st.meetings), icon: 'clock', sub: `${formatNumber(st.labMeetings)} of them labs` }),
      statTile({ label: 'Teachers & Rooms', value: formatNumber(st.teachers), unit: `· ${formatNumber(st.rooms)} rooms`, icon: 'users' }),
      statTile({ label: 'Saved Schedules', value: formatNumber(st.schedules), icon: 'book', sub: t.isPublished ? 'Students using it' : 'Publish to let students use it' }),
    ),
  ];

  const warnings = Array.isArray(t.warnings) ? t.warnings : [];
  parts.push(
    h(
      'div',
      { class: 'grid grid--wide-left', style: 'margin-top:16px' },
      card({
        title: 'Parser Notes',
        description: warnings.length ? 'Rows the parser skipped or had to guess at. Check them against the original file.' : null,
        body: warnings.length
          ? h('ul', { class: 'list', style: 'margin:0 -18px' }, warnings.map((w) => h('li', null, h('span', { class: 'feed-dot feed-dot--bad', 'aria-hidden': 'true' }, icon('alert', 14)), h('span', { class: 'grow feed-text' }, w))))
          : emptyState({ icon: 'check', title: 'Clean Parse', text: 'Every row of the file was read without notes.' }),
      }),
      card({
        title: 'File',
        body: h(
          'dl',
          { class: 'kv' },
          h('dt', null, 'File Name'), h('dd', null, t.fileName || '-'),
          h('dt', null, 'Size'), h('dd', null, formatBytes(t.fileSize)),
          h('dt', null, 'Class Lengths'), h('dd', null, t.explicitDurations ? 'Read from the file' : 'Estimated (80 min theory, 150 min lab)'),
          h('dt', null, 'Uploaded'), h('dd', null, `${formatDateTime(t.uploadedAt)}${t.uploader ? ` by ${t.uploader.displayName || t.uploader.email}` : ''}`),
          h('dt', null, 'Last Changed'), h('dd', null, formatDateTime(t.updatedAt)),
        ),
      }),
    ),
  );

  parts.push(sectionsCard(data.sections));
  clear(host, ...parts);
}

function sectionsCard(sections) {
  const state = { q: '', sort: 'sheet', shown: PAGE };
  const search = input({ type: 'search', class: 'input input--sm', placeholder: 'Search code, course, section, teacher or room', 'aria-label': 'Search sections' });
  const sort = select([['sheet', 'File Order'], ['picks', 'Most Picked'], ['code', 'Course Code']], 'sheet', { 'aria-label': 'Sort sections' });
  const host = h('div');
  const count = h('span', { class: 'muted', style: 'font-size:13px' });

  const draw = () => {
    const term = state.q.trim().toLowerCase();
    let rows = sections.filter(
      (s) =>
        !term ||
        [s.code, s.name, s.section, s.teacher, ...s.meetings.map((m) => m.room)].some((v) => (v || '').toLowerCase().includes(term)),
    );
    if (state.sort === 'picks') rows = [...rows].sort((a, b) => b.picks - a.picks || a.code.localeCompare(b.code));
    if (state.sort === 'code') rows = [...rows].sort((a, b) => a.code.localeCompare(b.code) || a.section.localeCompare(b.section));
    count.textContent = `${formatNumber(rows.length)} of ${formatNumber(sections.length)}`;
    if (!rows.length) {
      clear(host, emptyState({ icon: 'search', title: 'No Matching Sections' }));
      return;
    }
    clear(
      host,
      table(
        [
          { label: 'Course', main: true },
          { label: 'Section' },
          { label: 'Teacher' },
          { label: 'Classes' },
          { label: 'Students', className: 'num' },
        ],
        rows.slice(0, state.shown).map((s) => [
          h('div', { class: 'cell-title' }, h('strong', null, s.code), h('span', null, s.name)),
          h('span', { class: 'nowrap' }, s.section, s.nameIsLab || s.meetings.some((m) => m.isLab) ? h('span', { class: 'muted' }, ' · Lab') : null),
          s.teacher || h('span', { class: 'muted' }, '-'),
          h('div', { class: 'cell-title' }, s.meetings.length ? s.meetings.map((m) => h('span', { class: 'nowrap' }, meetingLabel(m))) : h('span', null, 'No classes')),
          formatNumber(s.picks),
        ]),
        { caption: 'Sections' },
      ),
      rows.length > state.shown
        ? h('div', { class: 'more-row' }, button(`Show More (${formatNumber(rows.length - state.shown)} left)`, {
            onClick: () => {
              state.shown += PAGE;
              draw();
            },
          }))
        : null,
    );
  };
  search.addEventListener('input', () => {
    state.q = search.value;
    state.shown = PAGE;
    draw();
  });
  sort.addEventListener('change', () => {
    state.sort = sort.value;
    draw();
  });
  draw();

  return h(
    'section',
    { class: 'card', style: 'margin-top:16px' },
    h('div', { class: 'card-head' }, h('h2', null, 'Sections'), count),
    h('div', { class: 'filters', style: 'padding:12px 18px 0;margin:0' }, h('div', { class: 'search grow' }, icon('search', 16), search), sort),
    h('div', { class: 'card-body card-body--flush' }, host),
  );
}
