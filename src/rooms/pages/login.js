// rooms/login.html: the Free Room Finder's own sign-in. No sign-up and no
// self-service reset: an admin creates and resets these accounts.

import { APP_PATH, getAccount, safeNext, signIn } from '../client.js';

const $ = (sel, root = document) => root.querySelector(sel);

const MESSAGES = {
  INVALID_CREDENTIALS: 'That username and password don’t match. Try again, or ask your admin to reset it.',
  ACCOUNT_DISABLED: 'This account has been disabled. Ask your admin if you need access.',
  RATE_LIMITED: 'Too many attempts. Wait a few minutes, then try again.',
};

const form = $('#signin-form');
const usernameInput = $('#signin-username');
const passwordInput = $('#signin-password');
const button = $('button[type="submit"]', form);
const destination = () => safeNext(new URLSearchParams(location.search).get('next')) || APP_PATH;

const ALERT_ICON =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 2.8 19.5h18.4Z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>';

function showError(message, invalidInput) {
  const alert = $('[data-alert]', form);
  alert.innerHTML = ALERT_ICON;
  const text = document.createElement('span');
  text.textContent = message;
  alert.append(text);
  alert.hidden = false;
  if (invalidInput) {
    invalidInput.setAttribute('aria-invalid', 'true');
    invalidInput.focus();
  }
}

function clearErrors() {
  const alert = $('[data-alert]', form);
  alert.hidden = true;
  alert.replaceChildren();
  for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
}

function setBusy(busy) {
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

const toggle = $('.pw-toggle');
toggle.addEventListener('click', () => {
  const visible = toggle.getAttribute('aria-pressed') !== 'true';
  passwordInput.type = visible ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (button.disabled) return;
  clearErrors();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username) return showError('Enter your username.', usernameInput);
  if (!password) return showError('Enter your password.', passwordInput);

  setBusy(true);
  const res = await signIn({ username, password });
  if (res.ok) {
    location.replace(destination());
    return;
  }
  setBusy(false);
  showError(MESSAGES[res.error.code] || res.error.message);
  if (res.error.code === 'INVALID_CREDENTIALS') passwordInput.select();
});

// Already signed in? Go straight to the finder.
getAccount().then((account) => {
  if (account) location.replace(destination());
});
