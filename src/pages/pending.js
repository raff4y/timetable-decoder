// pending.html: shows the pending / rejected / disabled message, re-checks
// /api/me every few seconds and moves on to /app.html once approved.
// Stable element ids: #pending-message, #pending-status, #signout-btn.

import { getCurrentUser, signOut } from '../auth-client.js';

const POLL_MS = 15_000;

const COPY = {
  pending: {
    title: 'You’re On The List',
    label: 'Pending review',
    message: 'Thanks for signing up. An admin needs to approve your account before you can use the timetable tool. This page moves you on automatically once that happens.',
    hint: 'This page refreshes on its own. You can leave it open.',
  },
  rejected: {
    title: 'Request Not Approved',
    label: 'Not approved',
    message: 'Your sign-up request was not approved. If you think this is a mistake, contact your timetable admin.',
    hint: 'If an admin changes this, the page will pick it up.',
  },
  disabled: {
    title: 'Account Disabled',
    label: 'Disabled',
    message: 'Your account has been disabled. Contact your timetable admin if you need access restored.',
    hint: 'If an admin restores access, the page will pick it up.',
  },
};

const viewEl = document.getElementById('status-view');
const titleEl = document.getElementById('pending-title');
const messageEl = document.getElementById('pending-message');
const statusEl = document.getElementById('pending-status');
const emailEl = document.getElementById('pending-email');
const hintEl = document.getElementById('pending-hint');
const signOutBtn = document.getElementById('signout-btn');

function render(user) {
  const status = COPY[user.status] ? user.status : 'pending';
  const copy = COPY[status];
  viewEl.dataset.status = status;
  statusEl.dataset.status = user.status;
  statusEl.textContent = copy.label;
  emailEl.textContent = user.email || user.displayName || 'Your account';
  hintEl.textContent = copy.hint;
  document.title = `${copy.title} · Timetable Decoder`;
  // Only touch live-region text when it changes, so polling doesn't re-announce it.
  if (titleEl.textContent !== copy.title) titleEl.textContent = copy.title;
  if (messageEl.textContent !== copy.message) messageEl.textContent = copy.message;
}

let timer = null;

async function check() {
  const user = await getCurrentUser();
  if (!user) {
    location.replace(`/login.html?next=${encodeURIComponent('/pending.html')}`);
    return;
  }
  if (user.status === 'approved') {
    location.replace('/app.html');
    return;
  }
  render(user);
  // Rejected / disabled will not change on their own, but an admin might fix
  // it, so keep polling, just slower.
  timer = setTimeout(check, user.status === 'pending' ? POLL_MS : POLL_MS * 4);
}

signOutBtn.addEventListener('click', async () => {
  clearTimeout(timer);
  signOutBtn.disabled = true;
  signOutBtn.textContent = 'Logging Out…';
  await signOut();
  location.replace('/login.html');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    clearTimeout(timer);
    check();
  }
});

check();
