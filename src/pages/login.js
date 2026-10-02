// login.html: sign in, sign up, forgot password, reset-sent and reset-confirm
// views in one card. Auth goes exclusively through src/auth-client.js (see
// docs/ARCHITECTURE.md); this file never touches tokens or cookies.
//
// Password reset is deliberately generic: requestPasswordReset() answers the
// same way for every well-formed email, and the server only sends a link to
// self-signed-up accounts (pre-added ones are reset by an admin). The UI must
// not branch on account type, so nobody can probe which emails exist.

import {
  signIn,
  signUp,
  requestPasswordReset,
  resetPassword,
  resendVerificationEmail,
  getCurrentUser,
  postSignInDestination,
} from '../auth-client.js';

const VIEWS = ['signin', 'signup', 'forgot', 'sent', 'verify', 'reset', 'done'];
const TITLES = {
  signin: 'Log In',
  signup: 'Create Account',
  forgot: 'Reset Password',
  sent: 'Check Your Inbox',
  verify: 'Verify Your Email',
  reset: 'Set A New Password',
  done: 'Password Updated',
};
const MIN_PASSWORD = 8;
const RESEND_COOLDOWN_MS = 30_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MESSAGES = {
  INVALID_CREDENTIALS: 'That email and password don’t match. Try again, or reset your password.',
  EMAIL_TAKEN: 'An account with that email already exists. Log in instead.',
  INVALID_EMAIL: 'Enter a valid email address.',
  RESET_TOKEN_INVALID: 'This reset link is invalid or has expired. Request a new one.',
  EMAIL_NOT_VERIFIED: 'Verify your email first: check your inbox for the verification link.',
  ACCOUNT_REVOKED: 'Your access has been revoked by an admin. Contact your timetable admin if you think this is a mistake.',
  RATE_LIMITED: 'Too many attempts. Wait a minute, then try again.',
  NETWORK: 'Can’t reach the server. Check your connection and try again.',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const params = new URLSearchParams(location.search);
const hashParams = new URLSearchParams(location.hash.slice(1));
const resetToken = params.get('token') || hashParams.get('token') || '';
// Captured once at load: showView() rewrites the query string as views change.
const initialSearch = location.search;

let current = null;

/** `?next=` when safe and the user is approved, else /app.html or /pending.html. */
const destinationFor = (user) => postSignInDestination(user, initialSearch);

// ---------- views ----------

function showView(name, { push = false, focus = true } = {}) {
  if (!VIEWS.includes(name)) name = 'signin';
  current = name;

  for (const section of $$('[data-view]')) {
    section.hidden = section.dataset.view !== name;
  }
  clearErrors(document);
  hideAllPasswords();
  document.title = `${TITLES[name]} · Timetable Decoder`;

  const url = new URL(location.href);
  if (name === 'signin') url.searchParams.delete('view');
  else url.searchParams.set('view', name);
  if (name !== 'reset') {
    url.searchParams.delete('token');
    url.hash = '';
  }
  const state = { view: name };
  if (push) history.pushState(state, '', url);
  else history.replaceState(state, '', url);

  if (focus) $(`[data-view="${name}"] h1`)?.focus();
}

window.addEventListener('popstate', (e) => {
  const view = e.state?.view || new URLSearchParams(location.search).get('view') || 'signin';
  showView(view, { focus: true });
});

function go(name) {
  carryEmail(current, name);
  showView(name, { push: true });
}

/** Typing your email once is enough: carry it into the next form if that one is empty. */
function carryEmail(from, to) {
  const source = { signin: '#signin-email', signup: '#signup-email', forgot: '#forgot-email' };
  const fromInput = source[from] && $(source[from]);
  const toInput = source[to] && $(source[to]);
  if (fromInput && toInput && !toInput.value && fromInput.value) toInput.value = fromInput.value.trim();
}

document.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-go]');
  if (trigger) go(trigger.dataset.go);
});

// ---------- show / hide password ----------

function setPasswordVisible(toggle, visible) {
  const input = document.getElementById(toggle.getAttribute('aria-controls'));
  if (!input) return;
  input.type = visible ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
}

function hideAllPasswords() {
  for (const toggle of $$('.pw-toggle')) setPasswordVisible(toggle, false);
}

for (const toggle of $$('.pw-toggle')) {
  toggle.addEventListener('click', () => {
    setPasswordVisible(toggle, toggle.getAttribute('aria-pressed') !== 'true');
  });
}

// ---------- errors + busy state ----------

const ALERT_ICON =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 2.8 19.5h18.4Z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>';
const INFO_ICON =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>';

function messageFor(error) {
  if (!error) return 'Something went wrong. Please try again.';
  if (error.code === 'WEAK_PASSWORD') return error.message || `Choose a stronger password, at least ${MIN_PASSWORD} characters.`;
  return MESSAGES[error.code] || error.message || 'Something went wrong. Please try again.';
}

function showError(scope, message, invalidInput, { tone = 'error' } = {}) {
  const alert = $('[data-alert]', scope);
  if (alert) {
    alert.classList.toggle('alert--info', tone === 'info');
    alert.innerHTML = tone === 'info' ? INFO_ICON : ALERT_ICON;
    const text = document.createElement('span');
    text.textContent = message;
    alert.append(text);
    alert.hidden = false;
  }
  if (invalidInput) {
    invalidInput.setAttribute('aria-invalid', 'true');
    invalidInput.focus();
  }
}

function clearErrors(scope) {
  for (const alert of $$('[data-alert]', scope)) {
    alert.hidden = true;
    alert.classList.remove('alert--info');
    alert.replaceChildren();
  }
  for (const input of $$('[aria-invalid]', scope)) input.removeAttribute('aria-invalid');
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  if (busy) {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    button.replaceChildren(spinner, `${button.dataset.busyLabel}…`);
  } else {
    button.textContent = button.dataset.label;
  }
}

/** Shared submit wrapper: validates, guards double submits, restores the button on failure. */
function handle(form, run) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('button[type="submit"]', form);
    if (button.disabled) return;
    clearErrors(form);
    hideAllPasswords();
    setBusy(button, true);
    let keepBusy = false;
    try {
      keepBusy = (await run()) === 'navigating';
    } catch (err) {
      // auth-client never throws for expected failures; this is a genuine bug or outage.
      console.error(err);
      showError(form, messageFor(null));
    } finally {
      if (!keepBusy) setBusy(button, false);
    }
  });
}

// ---------- sign in ----------

const signinForm = $('#signin-form');
handle(signinForm, async () => {
  const email = $('#signin-email').value.trim();
  const password = $('#signin-password').value;
  if (!EMAIL_RE.test(email)) return showError(signinForm, MESSAGES.INVALID_EMAIL, $('#signin-email'));
  if (!password) return showError(signinForm, 'Enter your password.', $('#signin-password'));

  const res = await signIn({ email, password });
  if (!res.ok && res.error?.code === 'EMAIL_NOT_VERIFIED') {
    openVerify(email, 'Your email isn’t verified yet. Open the link we sent to');
    return;
  }
  if (!res.ok) {
    const field = res.error?.code === 'INVALID_EMAIL' ? $('#signin-email') : null;
    showError(signinForm, messageFor(res.error), field);
    if (res.error?.code === 'INVALID_CREDENTIALS') $('#signin-password').select();
    return;
  }
  location.replace(destinationFor(res.user));
  return 'navigating';
});

// ---------- sign up ----------

const signupForm = $('#signup-form');
handle(signupForm, async () => {
  const name = $('#signup-name').value.trim();
  const email = $('#signup-email').value.trim();
  const password = $('#signup-password').value;
  if (!name) return showError(signupForm, 'Enter your name.', $('#signup-name'));
  if (!EMAIL_RE.test(email)) return showError(signupForm, MESSAGES.INVALID_EMAIL, $('#signup-email'));
  if (password.length < MIN_PASSWORD) {
    return showError(signupForm, `Use at least ${MIN_PASSWORD} characters for your password.`, $('#signup-password'));
  }

  const res = await signUp({ name, email, password });
  if (!res.ok) {
    const code = res.error?.code;
    const field =
      code === 'EMAIL_TAKEN' || code === 'INVALID_EMAIL' ? $('#signup-email')
      : code === 'WEAK_PASSWORD' ? $('#signup-password')
      : null;
    showError(signupForm, messageFor(res.error), field);
    return;
  }
  if (res.needsVerification) {
    signupForm.reset();
    openVerify(email, 'Almost there. Open the link we sent to');
    return;
  }
  location.replace(destinationFor(res.user));
  return 'navigating';
});

// ---------- email verification ----------

let verifyEmail = '';

function openVerify(email, lead) {
  verifyEmail = email;
  const text = $('#verify-text');
  const strong = document.createElement('strong');
  strong.id = 'verify-email';
  strong.textContent = email;
  text.replaceChildren(`${lead} `, strong, ', then come back and log in.');
  showView('verify', { push: true });
}

const verifyResendBtn = $('#verify-resend-btn');
verifyResendBtn.addEventListener('click', async () => {
  const section = $('[data-view="verify"]');
  if (!verifyEmail || verifyResendBtn.disabled) return;
  clearErrors(section);
  verifyResendBtn.disabled = true;
  const res = await resendVerificationEmail({ email: verifyEmail });
  if (!res.ok) {
    verifyResendBtn.disabled = false;
    showError(section, messageFor(res.error));
    return;
  }
  $('#verify-status').textContent = 'A new verification link is on its way.';
  cooldown(verifyResendBtn);
});

// ---------- forgot password ----------

const forgotForm = $('#forgot-form');
let lastResetEmail = '';

handle(forgotForm, async () => {
  const email = $('#forgot-email').value.trim();
  if (!EMAIL_RE.test(email)) return showError(forgotForm, MESSAGES.INVALID_EMAIL, $('#forgot-email'));

  const res = await requestPasswordReset({ email });
  if (!res.ok) {
    showError(forgotForm, messageFor(res.error), res.error?.code === 'INVALID_EMAIL' ? $('#forgot-email') : null);
    return;
  }
  lastResetEmail = email;
  $('#sent-email').textContent = email;
  showView('sent', { push: true });
  cooldown(resendBtn);
});

const resendBtn = $('#resend-btn');
const cooldownTimers = new WeakMap();

/** "Resend" buttons rest for a while after each send so nobody hammers the mail server. */
function cooldown(button) {
  clearTimeout(cooldownTimers.get(button));
  button.disabled = true;
  button.textContent = 'Sent';
  cooldownTimers.set(button, setTimeout(() => {
    button.disabled = false;
    button.textContent = 'Resend';
  }, RESEND_COOLDOWN_MS));
}

resendBtn.addEventListener('click', async () => {
  const section = $('[data-view="sent"]');
  if (!lastResetEmail || resendBtn.disabled) return;
  clearErrors(section);
  resendBtn.disabled = true;
  const res = await requestPasswordReset({ email: lastResetEmail });
  if (!res.ok) {
    resendBtn.disabled = false;
    showError(section, messageFor(res.error));
    return;
  }
  $('#resend-status').textContent = 'Another reset link is on its way.';
  cooldown(resendBtn);
});

// ---------- reset confirm (from the email link) ----------

const resetForm = $('#reset-form');
handle(resetForm, async () => {
  const newPassword = $('#reset-password').value;
  const confirm = $('#reset-confirm').value;
  if (!resetToken) return showError(resetForm, MESSAGES.RESET_TOKEN_INVALID);
  if (newPassword.length < MIN_PASSWORD) {
    return showError(resetForm, `Use at least ${MIN_PASSWORD} characters.`, $('#reset-password'));
  }
  if (newPassword !== confirm) return showError(resetForm, 'Those passwords don’t match.', $('#reset-confirm'));

  const res = await resetPassword({ token: resetToken, newPassword });
  if (!res.ok) {
    showError(resetForm, messageFor(res.error), res.error?.code === 'WEAK_PASSWORD' ? $('#reset-password') : null);
    return;
  }
  resetForm.reset();
  showView('done');
});

// ---------- boot ----------

function initialView() {
  const requested = params.get('view');
  if (resetToken || requested === 'reset') return 'reset';
  // 'sent' and 'done' only make sense right after an action on this page.
  if (requested === 'signup' || requested === 'forgot') return requested;
  return 'signin';
}

const first = initialView();
showView(first, { focus: false });
if (first === 'reset' && !resetToken) showError(resetForm, MESSAGES.RESET_TOKEN_INVALID);

// Sent here by auth-client after a forced sign-out.
const SIGNED_OUT_REASONS = {
  revoked: 'You have been signed out by an admin. If your access is still active, log in again.',
  expired: 'Your session has ended. Log in again to continue.',
};
const reason = params.get('reason');
// Informational, not a failure: shown in the calm brand tone rather than as an error.
if (first === 'signin' && SIGNED_OUT_REASONS[reason]) showError(signinForm, SIGNED_OUT_REASONS[reason], null, { tone: 'info' });
if (reason) {
  const url = new URL(location.href);
  url.searchParams.delete('reason');
  history.replaceState(history.state, '', url);
}

// Already signed in? Skip the form, except mid-reset where the link must be honoured.
if (first === 'signin' || first === 'signup') {
  getCurrentUser()
    .then((user) => {
      if (user && (current === 'signin' || current === 'signup')) location.replace(destinationFor(user));
    })
    .catch(() => {});
}
