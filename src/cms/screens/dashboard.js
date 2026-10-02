// Dashboard: one call to GET /api/admin/stats, then KPIs, 30-day trends, the
// approval queue, top timetables, Room Finder usage and recent activity.

import { api, busy, button, card, clear, emptyState, errorState, h, icon, linkButton, pageHead, skeleton, statTile, toast } from '../ui.js';
import { barList, columnChart, lineChart } from '../charts.js';
import {
  actionTone,
  delta,
  formatDateTime,
  formatDecimal,
  formatNumber,
  longDay,
  plural,
  shortDay,
  timeAgo,
} from '../format.js';

export async function render(ctx) {
  const refreshBtn = button('Refresh', { icon: 'refresh', onClick: () => load(true) });
  const updated = h('span', { class: 'updated' });
  const body = h('div');
  ctx.view.append(
    pageHead({
      eyebrow: 'Overview',
      title: 'Dashboard',
      description: 'Accounts, timetables and usage across Timetable Decoder, at a glance.',
      actions: [updated, refreshBtn],
    }),
    body,
  );
  body.append(skeleton(110, 280, 240));

  async function load(manual = false) {
    if (manual) body.classList.add('is-refreshing');
    const res = await (manual ? busy(refreshBtn, () => api('/admin/stats')) : api('/admin/stats'));
    if (!ctx.isCurrent()) return;
    body.classList.remove('is-refreshing');
    if (!res.ok) {
      clear(body, errorState(res.error.message, () => load(true)));
      return;
    }
    updated.textContent = `Updated ${formatDateTime(res.data.generatedAt).split(', ')[1]}`;
    clear(body, ...renderStats(res.data, ctx, () => load(true)));
  }
  await load();
}

function renderStats(s, ctx, reload) {
  const out = [];

  if (s.users.pending > 0) {
    out.push(
      h(
        'div',
        { class: 'callout' },
        h('div', null, h('strong', null, `${plural(s.users.pending, 'Person', 'People')} Waiting For Approval`), h('span', null, 'New sign-ups can’t use the app until an admin approves them.')),
        linkButton('Review Sign-Ups', '#/users?status=pending', { variant: 'primary', icon: 'userCheck' }),
      ),
    );
  }

  out.push(
    h(
      'div',
      { class: 'grid grid--4' },
      statTile({
        label: 'Approved Users',
        value: formatNumber(s.users.approved),
        icon: 'users',
        deltaInfo: delta(s.users.newThisWeek, s.users.newLastWeek, 'last week'),
        sub: `${formatNumber(s.users.newThisWeek)} new this week`,
      }),
      statTile({
        label: 'Active This Week',
        value: formatNumber(s.active.week),
        icon: 'pulse',
        deltaInfo: delta(s.active.week, s.active.lastWeek, 'last week'),
        sub: `${formatNumber(s.active.today)} today`,
      }),
      statTile({
        label: 'Saved Schedules',
        value: formatNumber(s.schedules.total),
        icon: 'book',
        sub: `${formatDecimal(s.schedules.avgSections)} sections on average · ${formatNumber(s.schedules.savedThisWeek)} this week`,
      }),
      statTile({
        label: 'Published Timetables',
        value: formatNumber(s.timetables.published),
        unit: `of ${formatNumber(s.timetables.total)}`,
        icon: 'calendar',
        sub: `${formatNumber(s.timetables.sections)} sections · ${formatNumber(s.timetables.meetings)} classes`,
      }),
    ),
  );

  const trend = s.trend.map((d) => ({ label: shortDay(d.day), tipLabel: longDay(d.day), signups: d.signups, active: d.active }));
  out.push(
    h(
      'div',
      { class: 'grid grid--2' },
      card({
        title: 'New Sign-Ups',
        description: `Accounts created per day, last ${trend.length} days`,
        body: columnChart(trend.map((d) => ({ label: d.label, tipLabel: d.tipLabel, value: d.signups })), {
          unit: 'sign-ups',
          caption: 'New sign-ups per day',
        }),
      }),
      card({
        title: 'Daily Active Users',
        description: `People who used the app each day, last ${trend.length} days · ${formatNumber(s.active.month)} this month`,
        body: lineChart(trend.map((d) => ({ label: d.label, tipLabel: d.tipLabel, value: d.active })), {
          unit: 'active',
          caption: 'Daily active users',
        }),
      }),
    ),
  );

  out.push(
    h(
      'div',
      { class: 'grid grid--wide-left' },
      pendingCard(s, ctx, reload),
      accountsCard(s),
    ),
  );

  out.push(
    h(
      'div',
      { class: 'grid grid--wide-left' },
      card({
        title: 'Most Used Timetables',
        description: 'Saved schedules per timetable',
        action: h('a', { href: '#/timetables' }, 'All Timetables'),
        body: s.topTimetables.length
          ? barList(
              s.topTimetables.map((t) => ({
                label: t.title || 'Untitled',
                sub: [t.department, t.semester, t.isPublished ? null : 'Draft'].filter(Boolean).join(' · '),
                value: t.schedules,
                href: `#/timetables/${t.id}`,
              })),
              { unit: 'saved' },
            )
          : emptyState({ icon: 'calendar', title: 'No Timetables Yet', text: 'Upload a department’s Excel export to get started.', action: linkButton('Upload Timetable', '#/timetables', { variant: 'primary', icon: 'upload' }) }),
      }),
      roomFinderCard(s.roomFinder),
    ),
  );

  out.push(activityCard(s.recentActivity));
  return out;
}

function pendingCard(s, ctx, reload) {
  if (!s.pendingUsers.length) {
    return card({
      title: 'Approval Queue',
      body: emptyState({ icon: 'userCheck', title: 'All Caught Up', text: 'Nobody is waiting for approval.' }),
    });
  }
  const decide = async (btn, user, status) => {
    const res = await busy(btn, () => api(`/admin/users/${user.id}`, { method: 'PATCH', body: { status } }));
    if (!res.ok) {
      toast(res.error.message, 'bad');
      return;
    }
    toast(`${status === 'approved' ? 'Approved' : 'Rejected'} ${user.email}`);
    ctx.refreshBadges();
    reload();
  };
  return card({
    title: 'Approval Queue',
    description: `Oldest first · ${plural(s.users.pending, 'request')} in total`,
    action: h('a', { href: '#/users?status=pending' }, 'See All'),
    flush: true,
    body: h(
      'ul',
      { class: 'list' },
      s.pendingUsers.map((u) => {
        const approve = button('Approve', { icon: 'check', variant: 'ok', size: 'xs' });
        const reject = button('Reject', { variant: 'danger', size: 'xs' });
        approve.addEventListener('click', () => decide(approve, u, 'approved'));
        reject.addEventListener('click', () => decide(reject, u, 'rejected'));
        return h(
          'li',
          null,
          h('div', { class: 'grow cell-title' }, h('strong', null, u.displayName || u.email), h('span', null, `${u.email} · signed up ${timeAgo(u.createdAt).toLowerCase()}`)),
          h('div', { class: 'row-actions' }, approve, reject),
        );
      }),
    ),
  });
}

function accountsCard(s) {
  // Identity comes from the row labels; one hue, so no colour key is needed.
  const rows = [
    { label: 'Approved', value: s.users.approved, href: '#/users?status=approved' },
    { label: 'Pending', value: s.users.pending, href: '#/users?status=pending' },
    { label: 'Rejected', value: s.users.rejected, href: '#/users?status=rejected' },
    { label: 'Disabled', value: s.users.disabled, href: '#/users?status=disabled' },
  ];
  return card({
    title: 'Accounts By Status',
    description: `${plural(s.users.total, 'account')} · ${plural(s.users.admins, 'admin')}`,
    action: h('a', { href: '#/users' }, 'Manage'),
    body: h(
      'div',
      null,
      barList(rows, { max: Math.max(1, s.users.total) }),
      s.users.unclaimedInvites
        ? h('p', { class: 'hint', style: 'margin-top:14px' }, `${plural(s.users.unclaimedInvites, 'pre-added account')} not signed in yet.`)
        : null,
    ),
  });
}

function roomFinderCard(rf) {
  if (!rf) {
    return card({ title: 'Room Finder', body: emptyState({ icon: 'door', title: 'Unavailable', text: 'Room Finder figures could not be loaded.' }) });
  }
  return card({
    title: 'Room Finder',
    description: 'Invite-only free-room lookup across published timetables',
    action: h('a', { href: '#/rooms' }, 'Manage'),
    body: h(
      'dl',
      { class: 'kv' },
      h('dt', null, 'Rooms Indexed'), h('dd', null, h('b', null, formatNumber(rf.rooms))),
      h('dt', null, 'Accounts'), h('dd', null, `${formatNumber(rf.activeAccounts)} active of ${formatNumber(rf.accounts)}`),
      h('dt', null, 'Signed In This Week'), h('dd', null, formatNumber(rf.signedInThisWeek)),
    ),
  });
}

export function activityList(entries) {
  return h(
    'ul',
    { class: 'list' },
    entries.map((e) =>
      h(
        'li',
        { class: 'feed-item' },
        h('span', { class: `feed-dot feed-dot--${actionTone(e.action)}`, 'aria-hidden': 'true' }, icon(e.targetType === 'timetable' ? 'calendar' : e.targetType === 'room' ? 'door' : 'users', 15)),
        h(
          'div',
          { class: 'grow' },
          h('div', { class: 'feed-text' }, e.summary),
          h('div', { class: 'feed-meta', title: formatDateTime(e.createdAt) }, `${e.actorName || e.actorEmail || 'System'} · ${timeAgo(e.createdAt)}`),
        ),
      ),
    ),
  );
}

function activityCard(entries) {
  return card({
    title: 'Recent Activity',
    action: h('a', { href: '#/activity' }, 'Full Log'),
    flush: !!entries.length,
    body: entries.length
      ? activityList(entries)
      : emptyState({ icon: 'history', title: 'No Changes Yet', text: 'Approvals, uploads and edits by admins will appear here.' }),
  });
}

