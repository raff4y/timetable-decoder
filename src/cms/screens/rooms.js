// Room Finder accounts (the invite-only Free Room Finder at /rooms/).
// API: GET/POST /api/admin/room-accounts, PATCH/DELETE ?id=<uuid>.
// Generated passwords come back once and are shown once, never stored here.

import {
  api, badge, busy, button, card, clear, emptyState, errorState, field, h, icon, input, linkButton,
  openDialog, pageHead, skeleton, table, toast,
} from '../ui.js';
import { formatDate, formatDateTime, formatNumber, plural, timeAgo } from '../format.js';

export async function render(ctx) {
  const state = { accounts: [] };
  const host = h('div');
  ctx.view.append(
    pageHead({
      eyebrow: 'Manage',
      title: 'Room Finder',
      description: 'The Free Room Finder has its own invite-only login. Create an account here and hand over the password. Nobody can sign up for it themselves.',
      actions: [
        linkButton('Open Room Finder', '/rooms/', { icon: 'external', external: true }),
        button('Add Account', { icon: 'plus', variant: 'primary', onClick: () => addAccount() }),
      ],
    }),
    host,
  );
  host.append(skeleton(260));

  async function load() {
    const res = await api('/admin/room-accounts');
    if (!ctx.isCurrent()) return;
    if (!res.ok) {
      clear(host, errorState(res.error.message, load));
      return;
    }
    state.accounts = res.data.accounts;
    draw();
  }

  function draw() {
    const list = state.accounts;
    if (!list.length) {
      clear(host, card({ body: emptyState({ icon: 'door', title: 'No Room Finder Accounts', text: 'Add one to give someone access to the free-room lookup.' }) }));
      return;
    }
    const active = list.filter((a) => a.status === 'active').length;
    clear(
      host,
      card({
        title: 'Accounts',
        description: `${plural(list.length, 'account')} · ${formatNumber(active)} active`,
        flush: true,
        body: table(
          [
            { label: 'Account', main: true },
            { label: 'Status' },
            { label: 'Last Sign-In' },
            { label: 'Password Set' },
            { label: 'Created' },
            { label: 'Actions', className: 'actions' },
          ],
          list.map((a) => [
            h('div', { class: 'cell-title' }, h('strong', null, a.displayName || a.username), h('span', { class: 'mono' }, a.username)),
            badge(a.status === 'active' ? 'Active' : 'Disabled', a.status === 'active' ? 'ok' : 'off'),
            h('span', { class: 'nowrap', title: a.lastLoginAt ? formatDateTime(a.lastLoginAt) : '' }, a.lastLoginAt ? timeAgo(a.lastLoginAt) : 'Never'),
            h('span', { class: 'nowrap', title: formatDateTime(a.passwordChangedAt) }, formatDate(a.passwordChangedAt)),
            h('span', { class: 'nowrap' }, formatDate(a.createdAt)),
            actions(a),
          ]),
          { caption: 'Room Finder accounts' },
        ),
      }),
    );
  }

  function actions(a) {
    const toggle = button(a.status === 'active' ? 'Disable' : 'Enable', { size: 'xs', variant: a.status === 'active' ? 'danger' : 'ok' });
    toggle.addEventListener('click', async () => {
      const status = a.status === 'active' ? 'disabled' : 'active';
      const res = await busy(toggle, () => patch(a.id, { status }));
      if (!res.ok) return toast(res.error.message, 'bad');
      replace(res.data.account);
      toast(status === 'active' ? `Enabled ${a.username}` : `Disabled ${a.username}; signed out everywhere`);
    });
    return h(
      'div',
      { class: 'row-actions' },
      button('Reset Password', { icon: 'key', size: 'xs', onClick: () => resetPassword(a) }),
      button('Rename', { icon: 'pencil', size: 'xs', onClick: () => rename(a) }),
      toggle,
      button('Delete', { icon: 'trash', size: 'xs', variant: 'danger', onClick: () => remove(a) }),
    );
  }

  const patch = (id, body) => api(`/admin/room-accounts?id=${encodeURIComponent(id)}`, { method: 'PATCH', body });

  function replace(account) {
    state.accounts = state.accounts.map((x) => (x.id === account.id ? account : x));
    draw();
  }

  async function addAccount() {
    const username = input({ type: 'text', placeholder: 'e.g. ahmed.raza or an email', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
    const name = input({ type: 'text', placeholder: 'Optional', maxlength: '200', autocomplete: 'off' });
    const created = await openDialog({
      title: 'Add Room Finder Account',
      description: 'A strong password is generated for you and shown once.',
      submitLabel: 'Create Account',
      fields: [
        field('Username', username, '3–64 characters: letters, digits and . _ @ + -'),
        field('Display Name', name),
      ],
      onSubmit: async () => {
        const res = await api('/admin/room-accounts', { method: 'POST', body: { username: username.value, displayName: name.value } });
        return res.ok ? res.data : res.error.message;
      },
    });
    if (!created) return;
    state.accounts = [...state.accounts, created.account].sort((x, y) => x.username.localeCompare(y.username));
    draw();
    if (created.temporaryPassword) await showPassword(created.account, created.temporaryPassword, 'Account Created');
  }

  async function resetPassword(a) {
    const out = await openDialog({
      title: `Reset Password For ${a.username}?`,
      description: 'A new password is generated and the account is signed out on every device.',
      submitLabel: 'Reset Password',
      danger: true,
      onSubmit: async () => {
        const res = await patch(a.id, { resetPassword: true });
        return res.ok ? res.data : res.error.message;
      },
    });
    if (!out) return;
    replace(out.account);
    if (out.temporaryPassword) await showPassword(out.account, out.temporaryPassword, 'New Password');
  }

  async function rename(a) {
    const name = input({ type: 'text', value: a.displayName || '', maxlength: '200', autocomplete: 'off' });
    const out = await openDialog({
      title: 'Rename Account',
      description: a.username,
      fields: [field('Display Name', name)],
      onSubmit: async () => {
        if (name.value.trim() === (a.displayName || '')) return true;
        const res = await patch(a.id, { displayName: name.value });
        return res.ok ? res.data.account : res.error.message;
      },
    });
    if (out && out !== true) {
      replace(out);
      toast('Account renamed');
    }
  }

  async function remove(a) {
    const done = await openDialog({
      title: `Delete ${a.username}?`,
      description: 'The account and its sessions are removed for good. To pause access instead, disable it.',
      submitLabel: 'Delete Account',
      danger: true,
      onSubmit: async () => {
        const res = await api(`/admin/room-accounts?id=${encodeURIComponent(a.id)}`, { method: 'DELETE' });
        return res.ok ? true : res.error.message;
      },
    });
    if (done) {
      state.accounts = state.accounts.filter((x) => x.id !== a.id);
      draw();
      toast(`Deleted ${a.username}`);
    }
  }

  await load();
}

/** Show a one-time password with a copy button. */
function showPassword(account, password, title) {
  const code = h('code', null, password);
  const copy = button('Copy', { icon: 'copy', size: 'xs' });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(password);
      copy.lastChild.textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
  });
  return openDialog({
    title,
    description: `Give this to ${account.displayName || account.username} privately. It won’t be shown again. They can change it after signing in at /rooms/login.html.`,
    fields: [
      h('div', { class: 'field' }, h('span', { class: 'hint' }, 'Username'), h('div', { class: 'secret' }, h('code', null, account.username))),
      h('div', { class: 'field' }, h('span', { class: 'hint' }, 'Password'), h('div', { class: 'secret' }, icon('lock', 16), code, copy)),
    ],
    submitLabel: 'Done',
    hideCancel: true,
  });
}
