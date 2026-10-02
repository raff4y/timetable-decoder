// cms.html: the admin CMS shell. Admins only (requireUser({ role: 'admin' }));
// every request is checked again server-side. Screens are hash routes so the
// page is one static file:
//
//   #/                     Dashboard (statistics)
//   #/users[?status=]      Accounts: approve, roles, pre-add
//   #/timetables           Timetable library: upload, publish, edit, delete
//   #/timetables/<id>      One timetable: sections, warnings, picks
//   #/demand[?t=<id>]      Course demand from saved schedules
//   #/rooms                Free Room Finder accounts
//   #/activity             Audit log of admin changes

import { requireUser, signOut } from '../auth-client.js';
import { api, clear, h, icon } from './ui.js';
import { initials } from './format.js';
import * as dashboard from './screens/dashboard.js';
import * as users from './screens/users.js';
import * as timetables from './screens/timetables.js';
import * as timetable from './screens/timetable.js';
import * as demand from './screens/demand.js';
import * as rooms from './screens/rooms.js';
import * as activity from './screens/activity.js';

const NAV = [
  { group: 'Overview', items: [{ path: '/', label: 'Dashboard', icon: 'dashboard' }] },
  {
    group: 'Manage',
    items: [
      { path: '/users', label: 'Users', icon: 'users', badge: 'pending' },
      { path: '/timetables', label: 'Timetables', icon: 'calendar' },
      { path: '/rooms', label: 'Room Finder', icon: 'door' },
    ],
  },
  {
    group: 'Insights',
    items: [
      { path: '/demand', label: 'Course Demand', icon: 'chart' },
      { path: '/activity', label: 'Activity Log', icon: 'history' },
    ],
  },
];

const $ = (id) => document.getElementById(id);
const view = $('cms-view');
const sidebar = $('cms-sidebar');
const scrim = $('nav-scrim');
const navOpen = $('nav-open');

let me = null;
let renderSeq = 0;
const badges = { pending: 0 };

// ---------------------------------------------------------------- routing

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const path = `/${pathPart.split('/').filter(Boolean).join('/')}`;
  return { path, parts: path.split('/').filter(Boolean), query: new URLSearchParams(queryPart) };
}

function pick(route) {
  const [first, second] = route.parts;
  if (!first) return { screen: dashboard, nav: '/' };
  if (first === 'users') return { screen: users, nav: '/users' };
  if (first === 'timetables' && second) return { screen: timetable, nav: '/timetables' };
  if (first === 'timetables') return { screen: timetables, nav: '/timetables' };
  if (first === 'demand') return { screen: demand, nav: '/demand' };
  if (first === 'rooms') return { screen: rooms, nav: '/rooms' };
  if (first === 'activity') return { screen: activity, nav: '/activity' };
  return null;
}

async function render() {
  const seq = ++renderSeq;
  const route = parseHash();
  const hit = pick(route);
  closeNav();
  if (!hit) {
    location.replace('#/');
    return;
  }
  markActive(hit.nav);
  const ctx = {
    view,
    route,
    me,
    isCurrent: () => seq === renderSeq,
    go: (hash) => {
      location.hash = hash;
    },
    /** Replace the query without a new history entry or a re-render. */
    setQuery(params) {
      const q = new URLSearchParams(params);
      for (const [k, v] of [...q]) if (!v) q.delete(k);
      const qs = q.toString();
      history.replaceState(null, '', `#${route.path}${qs ? `?${qs}` : ''}`);
      route.query = q;
    },
    refreshBadges,
  };
  clear(view);
  window.scrollTo(0, 0);
  try {
    await hit.screen.render(ctx);
  } catch (err) {
    console.error(err);
  }
  if (ctx.isCurrent()) {
    const title = view.querySelector('h1');
    document.title = `${title ? title.textContent : 'CMS'} · Timetable Decoder CMS`;
    if (document.activeElement === document.body || !view.contains(document.activeElement)) {
      title?.focus({ preventScroll: true });
    }
  }
}

// ---------------------------------------------------------------- sidebar

function buildNav() {
  const nav = $('sidebar-nav');
  clear(
    nav,
    NAV.map((g) =>
      h(
        'div',
        { class: 'nav-group' },
        h('h2', null, g.group),
        h(
          'ul',
          null,
          g.items.map((item) =>
            h(
              'li',
              null,
              h(
                'a',
                { class: 'nav-link', href: `#${item.path}`, dataset: { path: item.path } },
                icon(item.icon, 18),
                h('span', null, item.label),
                item.badge ? h('span', { class: 'nav-count', dataset: { badge: item.badge }, hidden: true }) : null,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function markActive(path) {
  for (const a of document.querySelectorAll('.nav-link')) {
    if (a.dataset.path === path) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

async function refreshBadges() {
  const res = await api('/admin/users?status=pending');
  if (!res.ok) return;
  badges.pending = res.data.users.length;
  for (const el of document.querySelectorAll('[data-badge="pending"]')) {
    el.textContent = String(badges.pending);
    el.hidden = badges.pending === 0;
    el.setAttribute('aria-label', `${badges.pending} waiting`);
  }
}

function openNav() {
  sidebar.classList.add('open');
  scrim.hidden = false;
  navOpen.setAttribute('aria-expanded', 'true');
  (sidebar.querySelector('.nav-link[aria-current]') || $('nav-close')).focus();
}

function closeNav() {
  if (!sidebar.classList.contains('open')) return;
  sidebar.classList.remove('open');
  scrim.hidden = true;
  navOpen.setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------- boot

async function boot() {
  me = await requireUser({ role: 'admin' });
  if (!me) return; // redirected

  navOpen.append(icon('menu', 22));
  $('nav-close').append(icon('x', 20));
  $('open-app').append(icon('calendar', 15), 'Open App');
  const signOutBtn = $('signout-btn');
  signOutBtn.append(icon('logout', 15), 'Log Out');
  $('me-avatar').textContent = initials(me.displayName, me.email);
  $('me-name').textContent = me.displayName || me.email.split('@')[0];
  $('me-email').textContent = me.email;
  buildNav();

  navOpen.addEventListener('click', openNav);
  $('nav-close').addEventListener('click', () => {
    closeNav();
    navOpen.focus();
  });
  scrim.addEventListener('click', closeNav);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar.classList.contains('open')) {
      closeNav();
      navOpen.focus();
    }
  });
  signOutBtn.addEventListener('click', async () => {
    signOutBtn.disabled = true;
    await signOut();
    location.replace('/login.html');
  });
  window.addEventListener('hashchange', render);

  $('cms-boot').remove();
  $('cms').hidden = false;
  refreshBadges();
  await render();
}

boot();
