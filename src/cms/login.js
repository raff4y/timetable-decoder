// /cms/login (cms/login.html): the CMS's own login. Same accounts as the main
// site (one Neon Auth user per person), but only approved admins get through:
// anyone else is signed straight back out, so a student who wanders in here is
// not left half signed in. Auth goes through src/auth-client.js only.

import { getCurrentUser, safeNext, signIn, signOut } from '../auth-client.js';

const CMS_HOME = '/cms';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MESSAGES = {
  INVALID_CREDENTIALS: 'That email and password don’t match. Try again.',
  INVALID_EMAIL: 'Enter a valid email address.',
  EMAIL_NOT_VERIFIED: 'Verify your email first: check your inbox for the verification link.',
  ACCOUNT_REVOKED: 'Your access has been revoked. Contact another admin if you think this is a mistake.',
  RATE_LIMITED: 'Too many attempts. Wait a minute, then try again.',
  NETWORK: 'Can’t reach the server. Check your connection and try again.',
  NOT_ADMIN: 'This account doesn’t have admin access. Students log in on the main login page.',
};
const SIGNED_OUT_REASONS = {
  revoked: 'You have been signed out by an admin. If your access is still active, log in again.',
  expired: 'Your session has ended. Log in again to continue.',
};

const $ = (sel, root = document) => root.querySelector(sel);

const params = new URLSearchParams(location.search);
// Only ever send people on to a CMS page.
const requested = safeNext(params.get('next'));
const destination = requested && /^\/cms(?:[/?#]|$)/.test(requested) && !requested.startsWith('/cms/login') ? requested : CMS_HOME;

const isAdmin = (user) => user?.role === 'admin' && user.status === 'approved';

const form = $('#signin-form');
const emailInput = $('#signin-email');
const passwordInput = $('#signin-password');
const submit = $('button[type="submit"]', form);
const alertBox = $('[data-alert]', form);

// ---------- show / hide password ----------

const toggle = $('.pw-toggle');
function setPasswordVisible(visible) {
  passwordInput.type = visible ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
}
toggle.addEventListener('click', () => setPasswordVisible(toggle.getAttribute('aria-pressed') !== 'true'));

// ---------- errors + busy state ----------

const ALERT_ICON =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 2.8 19.5h18.4Z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>';
const INFO_ICON =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>';

function showMessage(message, { tone = 'error', field = null } = {}) {
  alertBox.classList.toggle('alert--info', tone === 'info');
  alertBox.innerHTML = tone === 'info' ? INFO_ICON : ALERT_ICON;
  const text = document.createElement('span');
  text.textContent = message;
  alertBox.append(text);
  alertBox.hidden = false;
  if (field) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }
}

function clearMessage() {
  alertBox.hidden = true;
  alertBox.classList.remove('alert--info');
  alertBox.replaceChildren();
  for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
}

function setBusy(busy) {
  submit.disabled = busy;
  submit.setAttribute('aria-busy', String(busy));
  if (busy) {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    submit.replaceChildren(spinner, `${submit.dataset.busyLabel}…`);
  } else {
    submit.textContent = submit.dataset.label;
  }
}

// ---------- sign in ----------

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submit.disabled) return;
  clearMessage();
  setPasswordVisible(false);

  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!EMAIL_RE.test(email)) return showMessage(MESSAGES.INVALID_EMAIL, { field: emailInput });
  if (!password) return showMessage('Enter your password.', { field: passwordInput });

  setBusy(true);
  try {
    const res = await signIn({ email, password });
    if (res.ok && isAdmin(res.user)) {
      location.replace(destination);
      return; // stay busy while the CMS loads
    }
    if (res.ok) {
      await signOut();
      showMessage(MESSAGES.NOT_ADMIN);
    } else {
      showMessage(MESSAGES[res.error?.code] || res.error?.message || 'Something went wrong. Please try again.', {
        field: res.error?.code === 'INVALID_EMAIL' ? emailInput : null,
      });
      if (res.error?.code === 'INVALID_CREDENTIALS') passwordInput.select();
    }
  } catch (err) {
    console.error(err);
    showMessage('Something went wrong. Please try again.');
  }
  setBusy(false);
});

// ---------- boot ----------

const reason = params.get('reason');
if (SIGNED_OUT_REASONS[reason]) showMessage(SIGNED_OUT_REASONS[reason], { tone: 'info' });
if (reason) {
  const url = new URL(location.href);
  url.searchParams.delete('reason');
  history.replaceState(history.state, '', url);
}

// Already signed in as an admin? Skip the form.
getCurrentUser()
  .then((user) => {
    if (isAdmin(user) && !submit.disabled) location.replace(destination);
  })
  .catch(() => {});
