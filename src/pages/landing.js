// index.html (public landing). The page is fully static; the only script work
// is swapping the sign-up calls to action for "Open App" when the visitor is
// already signed in.

import { getCurrentUser } from '../auth-client.js';

function appPathFor(user) {
  return user.status === 'approved' ? '/app.html' : '/pending.html';
}

function showSignedIn(user) {
  const href = appPathFor(user);
  const label = user.status === 'approved' ? 'Open App' : 'Check Status';

  const navLogin = document.getElementById('nav-login');
  const navCta = document.getElementById('nav-cta');
  const heroCta = document.getElementById('hero-cta');
  const bandActions = document.getElementById('cta-band-actions');

  if (navLogin) navLogin.hidden = true;
  if (navCta) {
    navCta.href = href;
    navCta.textContent = label;
  }
  if (heroCta) {
    heroCta.href = href;
    heroCta.firstChild.textContent = `${label} `;
  }
  if (bandActions) {
    const open = document.createElement('a');
    open.className = 'btn btn--on-dark btn--lg';
    open.href = href;
    open.textContent = label;
    bandActions.replaceChildren(open);
  }
}

getCurrentUser()
  .then((user) => {
    if (user) showSignedIn(user);
  })
  .catch(() => {
    // Signed-out visitors and network blips both just keep the default page.
  });
