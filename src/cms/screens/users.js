// Users: approve / reject sign-ups, change role or status, rename, pre-add.
// Reads GET /api/admin/users once; writes go through PATCH /api/admin/users/:id
// and POST /api/admin/users (the server enforces the last-admin guard).

import {
  api, badge, busy, button, card, clear, emptyState, errorState, field, h, icon, input, openDialog,
  pageHead, select, skeleton, table, titleCell, toast,
} from '../ui.js';
import { formatDate, formatDateTime, formatNumber, plural, ROLE_LABEL, SOURCE_LABEL, STATUS_LABEL, STATUS_TONE, timeAgo } from '../format.js';

const STATUSES = ['all', 'pending', 'approved', 'rejected', 'disabled'];
const PAGE = 100;

/** Quick actions per status: [label, nextStatus, variant]. */
function quickActions(user) {
  switch (user.status) {
    case 'pending': return [['Approve', 'approved', 'ok'], ['Reject', 'rejected', 'danger']];
    case 'approved': return [['Disable', 'disabled', 'danger']];
    case 'rejected': return [['Approve', 'approved', 'ok']];
    case 'disabled': return [['Re-Enable', 'approved', 'ok']];
    default: return [];
  }
}

export async function render(ctx) {
  const q = ctx.route.query;
  const state = {
    users: [],
    status: STATUSES.includes(q.get('status')) ? q.get('status') : 'all',
    role: ['student', 'admin'].includes(q.get('role')) ? q.get('role') : '',
    search: q.get('q') || '',
    shown: PAGE,
  };

  const addBtn = button('Add User', { icon: 'userPlus', variant: 'primary', onClick: () => addUser() });
  const approveAllBtn = button('', { icon: 'check', variant: 'ok' });
  approveAllBtn.hidden = true;
  approveAllBtn.addEventListener('click', () => approveAll());

  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filter by status' });
  const searchInput = input({ type: 'search', class: 'input input--sm', placeholder: 'Search name or email', value: state.search, 'aria-label': 'Search users' });
  const roleSelect = select([['', 'All Roles'], ['student', 'Students'], ['admin', 'Admins']], state.role, { 'aria-label': 'Filter by role' });
  const listHost = h('div');

  ctx.view.append(
    pageHead({
      eyebrow: 'Manage',
      title: 'Users',
      description: 'Approve sign-ups, change roles and access, or pre-add people so they’re approved the moment they sign up.',
      actions: [approveAllBtn, addBtn],
    }),
    h('div', { class: 'filters' }, tabs),
    h(
      'div',
      { class: 'filters' },
      h('div', { class: 'search grow' }, icon('search', 16), searchInput),
      roleSelect,
    ),
    listHost,
  );
  listHost.append(skeleton(320));

  searchInput.addEventListener('input', () => {
    state.search = searchInput.value;
    state.shown = PAGE;
    sync();
  });
  roleSelect.addEventListener('change', () => {
    state.role = roleSelect.value;
    state.shown = PAGE;
    sync();
  });

  function sync() {
    ctx.setQuery({ status: state.status === 'all' ? '' : state.status, role: state.role, q: state.search.trim() });
    draw();
  }

  async function load() {
    const res = await api('/admin/users');
    if (!ctx.isCurrent()) return;
    if (!res.ok) {
      clear(listHost, errorState(res.error.message, load));
      return;
    }
    state.users = res.data.users;
    draw();
  }

  function filtered() {
    const term = state.search.trim().toLowerCase();
    return state.users
      .filter((u) => state.status === 'all' || u.status === state.status)
      .filter((u) => !state.role || u.role === state.role)
      .filter((u) => !term || u.email.toLowerCase().includes(term) || (u.displayName || '').toLowerCase().includes(term))
      .sort((a, b) => (state.status === 'pending' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)));
  }

  function draw() {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, s === 'all' ? state.users.length : state.users.filter((u) => u.status === s).length]));
    clear(
      tabs,
      STATUSES.map((s) =>
        h(
          'button',
          {
            type: 'button',
            class: 'tab',
            'aria-pressed': String(state.status === s),
            onClick: () => {
              state.status = s;
              state.shown = PAGE;
              sync();
            },
          },
          s === 'all' ? 'All' : STATUS_LABEL[s],
          h('span', { class: 'tab-count' }, formatNumber(counts[s])),
        ),
      ),
    );

    approveAllBtn.hidden = !(state.status === 'pending' && counts.pending > 1);
    approveAllBtn.lastChild.textContent = `Approve All ${counts.pending}`;

    const rows = filtered();
    if (!rows.length) {
      clear(
        listHost,
        card({
          body: emptyState({
            icon: 'users',
            title: state.users.length ? 'No Matching Users' : 'No Users Yet',
            text: state.users.length ? 'Try another status, role or search.' : 'People appear here once they sign up or you pre-add them.',
          }),
        }),
      );
      return;
    }
    const visible = rows.slice(0, state.shown);
    const tableEl = table(
      [
        { label: 'Person', main: true },
        { label: 'Role' },
        { label: 'Status' },
        { label: 'Joined' },
        { label: 'Last Seen' },
        { label: 'Schedules', className: 'num' },
        { label: 'Actions', className: 'actions' },
      ],
      visible.map((u) => [
        h(
          'div',
          { class: 'cell-title' },
          h('strong', null, u.displayName || u.email.split('@')[0], u.id === ctx.me.id ? h('span', { class: 'you' }, 'You') : null),
          h('span', null, `${u.email} · ${SOURCE_LABEL[u.source] || u.source}`),
        ),
        badge(ROLE_LABEL[u.role] || u.role, u.role === 'admin' ? 'info' : 'off', { plain: true }),
        badge(STATUS_LABEL[u.status] || u.status, STATUS_TONE[u.status] || 'off'),
        h('span', { class: 'nowrap', title: formatDateTime(u.createdAt) }, formatDate(u.createdAt)),
        h('span', { class: 'nowrap', title: u.lastSeenAt ? formatDateTime(u.lastSeenAt) : 'Never signed in' }, u.lastSeenAt ? timeAgo(u.lastSeenAt) : (u.source === 'preadded' ? 'Not Signed In Yet' : 'Never')),
        formatNumber(u.scheduleCount ?? 0),
        h(
          'div',
          { class: 'row-actions' },
          (u.id === ctx.me.id ? [] : quickActions(u)).map(([label, status, variant]) => {
            const b = button(label, { variant, size: 'xs' });
            b.addEventListener('click', () => setStatus(b, u, status));
            return b;
          }),
          button('Edit', { icon: 'pencil', size: 'xs', onClick: () => editUser(u) }),
        ),
      ]),
      { caption: 'Users' },
    );
    clear(
      listHost,
      card({
        flush: true,
        body: [
          tableEl,
          rows.length > state.shown
            ? h('div', { class: 'more-row' }, button(`Show ${Math.min(PAGE, rows.length - state.shown)} More of ${formatNumber(rows.length - state.shown)}`, {
                onClick: () => {
                  state.shown += PAGE;
                  draw();
                },
              }))
            : null,
        ],
      }),
    );
  }

  function replaceUser(updated) {
    state.users = state.users.map((u) => (u.id === updated.id ? { ...u, ...updated } : u));
  }

  async function setStatus(btn, user, status) {
    const res = await busy(btn, () => api(`/admin/users/${user.id}`, { method: 'PATCH', body: { status } }));
    if (!res.ok) {
      toast(res.error.message, 'bad');
      return;
    }
    replaceUser(res.data.user);
    toast(`${STATUS_LABEL[status]}: ${user.email}`);
    ctx.refreshBadges();
    draw();
  }

  async function approveAll() {
    const pending = state.users.filter((u) => u.status === 'pending');
    const ok = await openDialog({
      title: `Approve ${plural(pending.length, 'Person', 'People')}?`,
      description: 'Everyone waiting will get access to the timetable tool straight away.',
      submitLabel: 'Approve All',
      onSubmit: async () => {
        let done = 0;
        for (const u of pending) {
          const res = await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { status: 'approved' } });
          if (!res.ok) return `Stopped after ${done}: ${res.error.message}`;
          replaceUser(res.data.user);
          done++;
        }
        return done;
      },
    });
    if (ok) toast(`Approved ${plural(ok, 'person', 'people')}`);
    ctx.refreshBadges();
    draw();
  }

  async function editUser(user) {
    const name = input({ type: 'text', value: user.displayName || '', maxlength: '200', autocomplete: 'off' });
    const role = select([['student', 'Student'], ['admin', 'Admin']], user.role);
    const status = select(['pending', 'approved', 'rejected', 'disabled'].map((s) => [s, STATUS_LABEL[s]]), user.status);
    const saved = await openDialog({
      title: 'Edit User',
      description: user.email,
      fields: [
        field('Display Name', name),
        field('Role', role, 'Admins can open this CMS and manage everything in it.'),
        field('Status', status, 'Only approved people can use the app. Rejected and disabled people keep their saved schedules.'),
      ],
      onSubmit: async () => {
        const body = {};
        if (name.value.trim() !== (user.displayName || '')) body.displayName = name.value;
        if (role.value !== user.role) body.role = role.value;
        if (status.value !== user.status) body.status = status.value;
        if (!Object.keys(body).length) return true;
        const res = await api(`/admin/users/${user.id}`, { method: 'PATCH', body });
        if (!res.ok) return res.error.message;
        replaceUser(res.data.user);
        return res.data.user;
      },
    });
    if (saved && saved !== true) {
      toast(`Saved ${user.email}`);
      ctx.refreshBadges();
      draw();
    }
  }

  async function addUser() {
    const email = input({ type: 'email', placeholder: 'name@nu.edu.pk', autocomplete: 'off', required: true });
    const name = input({ type: 'text', placeholder: 'Optional', maxlength: '200', autocomplete: 'off' });
    const role = select([['student', 'Student'], ['admin', 'Admin']], 'student');
    const created = await openDialog({
      title: 'Add User',
      description: 'Pre-added people are approved already. They sign up with this email, verify it, and they’re in.',
      submitLabel: 'Add User',
      fields: [field('Email', email), field('Display Name', name), field('Role', role)],
      onSubmit: async () => {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) return 'Enter a valid email address.';
        const res = await api('/admin/users', { method: 'POST', body: { email: email.value, displayName: name.value, role: role.value } });
        if (!res.ok) return res.error.message;
        return res.data.user;
      },
    });
    if (created) {
      state.users.push({ ...created, scheduleCount: 0 });
      toast(`Added ${created.email}`);
      draw();
    }
  }

  await load();
}
