# Architecture & contracts (v2: Neon-backed, login-gated)

This is the shared contract between everyone working on v2. If you need to
change something here, change this file in the same edit and tell the other
owners - other code is being written against it in parallel.

## What changed from v1

v1 was a static page that parsed an uploaded xlsx in the browser. v2:

- **Login required.** Nobody sees timetable data without an approved account.
- **Accounts** come from two places:
  - **Self sign-up** -> account is `pending` until an admin approves it.
  - **Pre-added by an admin** (`npm run seed:users` or the admin CMS) ->
    `approved` from the start.
- **Auth is Neon Auth** (managed; the user store lives in our Neon database).
  Our own `app_users` table holds role + approval status, linked to the
  Neon Auth user.
- **Timetables are shared and server-parsed.** An admin uploads a department's
  xlsx once; the server parses it (the parser moves out of `app.js` into
  `server/parser/`) and stores sections/meetings in Postgres. Students pick a
  published timetable; they never upload files.
- **Saved schedules** - each user's picked sections per timetable live in the DB
  and come back on any device.
- The canvas rendering, conflict detection, colours and PNG export stay
  client-side in `app.js`.

## Stack

- Front end: Vite, multi-page, vanilla JS modules. No framework.
- API: Vercel Node functions in `api/` - `export default route({ GET, POST, ... })`
  using the helpers in `server/http.js` (do not use Vercel-only `res.status().json()`;
  handlers must also run under `scripts/dev-server.mjs`).
- DB: Neon Postgres. `server/db.js` exports `query(text, params)` / `tx(fn)`.
  Tests inject PGlite via `setDbDriver()`. Test files that go through the real auth
  or rate limits must call `resetRateLimitMemory()` (`server/rate-limit.js`) in
  `beforeEach`, next to `DELETE FROM auth_rate_limits`, or counters leak between tests.
  Tests may lower a limit temporarily via the exported `LIMITS` object.
- Migrations: plain SQL in `db/migrations/NNN_name.sql`, applied in order by
  `scripts/migrate.mjs` and tracked in a `schema_migrations` table.

## Environment variables (`.env.example` lists them)

| var | used by | meaning |
|---|---|---|
| `DATABASE_URL` | server | Neon (or local) Postgres connection string |
| `NEON_AUTH_URL` | server | Neon Auth base URL (ends in `/neondb/auth` or similar); JWTs are verified against `<it>/.well-known/jwks.json`, issuer = its origin |
| `VITE_NEON_AUTH_URL` | browser | same URL, exposed to the client SDK |
| `ADMIN_EMAILS` | seed script | optional comma list promoted to admin on seed |
| `NEON_AUTH_JWKS_URL`, `NEON_AUTH_ISSUER` | server | optional overrides (tests point these at a local key) |
| `APP_ORIGIN` | server | optional extra origins accepted as password-reset redirect targets |
| `API_PORT` | dev | port of `scripts/dev-server.mjs` (default 8787); Vite proxies `/api` to it |

## File ownership

| owner | files |
|---|---|
| **design session** (separate Claude session) | `index.html` (landing), `login.html` (sign in, sign up, forgot password, reset-confirm views), `src/pages/landing.js`, `src/pages/login.js`, `src/styles/brand.css`, `public/**` (brand assets), any assets they add |
| **platform/auth agent** | `vite.config.js`, `vercel.json`, `.env.example`, `db/migrations/001_*`, `server/auth.js`, `api/me.js`, `api/auth/**`, `api/admin/users*`, `scripts/dev-server.mjs`, `scripts/migrate.mjs`, `scripts/seed-users.mjs`, `src/auth-client.js`, `pending.html` + `src/pages/pending.js`, `tests/auth*` |
| **timetable-data agent** | `server/parser/**`, `db/migrations/002_*`, `db/migrations/003_*`, `api/timetables/**`, `api/schedules/**`, `tests/parser*`, `tests/timetables*`, `tests/schedules*`, `tests/fixtures/**` |
| **later front-end pass** | `app.html`, `app.js`, `styles.css`, `admin.html` (now only a redirect to `/cms.html`) |
| shared, already written | `package.json` (deps installed; ask before adding), `server/db.js`, `server/http.js` |

`app.html` is the old `index.html` (the timetable tool) renamed; `index.html`
is now the public landing page.

## Pages

| page | public? | purpose |
|---|---|---|
| `/` `index.html` | public | landing |
| `/login.html` | public | sign in / sign up / forgot password / reset password |
| `/pending.html` | signed-in, not approved | "waiting for approval" / "rejected" / "disabled" |
| `/app.html` | approved users | the timetable tool |
| `/admin.html` | - | redirects to `/cms.html` (kept for old links; `vercel.json` also redirects it) |
| `/cms.html` | admins | the one admin UI: statistics dashboard, users, timetables, Room Finder accounts, course demand, activity log (see "Admin CMS") |
| `/rooms/login.html` | public | Free Room Finder sign-in (its own accounts, no sign-up) |
| `/rooms/` `rooms/index.html` | Room Finder accounts | the Free Room Finder (see below) |

Page gating is client-side (`requireUser()` from `src/auth-client.js`), which
is fine: pages hold no data, and **every data request goes through `/api/*`,
which checks auth server-side**. That's the real boundary.

## Front-end auth module: `src/auth-client.js`

Pages never talk to Neon Auth or handle tokens directly - they import this.
Every function returns a result object and never throws for expected failures:

```js
// success: { ok: true, ...data }   failure: { ok: false, error: { code, message } }
signIn({ email, password })                  // -> { ok, user }   (user = /api/me shape)
signUp({ name, email, password })            // -> { ok, user }   (user.status is 'pending', or 'approved' if pre-added)
signOut()                                    // -> { ok }
requestPasswordReset({ email })              // -> { ok }  ALWAYS ok for a well-formed email (no account enumeration)
resetPassword({ token, newPassword })        // -> { ok }
getCurrentUser()                             // -> user | null   (calls GET /api/me)
requireUser({ role, allowPending })          // page guard: redirects and resolves null, or resolves user
apiFetch(path, init)                         // fetch() to /api with auth attached; JSON in/out
```

Redirects done by `requireUser()`: not signed in -> `/login.html?next=<path>`;
status `pending`/`rejected`/`disabled` -> `/pending.html` (unless
`allowPending`); `role: 'admin'` required but user is a student -> `/app.html`.
After a successful sign-in, the login page should go to `next` if it's a
same-origin path, otherwise to `/app.html` for approved users or
`/pending.html` for the rest.

Error codes (`error.code`): `INVALID_CREDENTIALS`, `EMAIL_TAKEN`,
`WEAK_PASSWORD`, `INVALID_EMAIL`, `RESET_TOKEN_INVALID`, `RATE_LIMITED`,
`NETWORK`, `UNKNOWN`, plus the additive `EMAIL_NOT_VERIFIED` (sign-in refused
until the address is verified) and `ACCOUNT_REVOKED` (signIn/signUp: an admin
revoked this account; the Neon session is ended before returning).
`error.message` is human-readable and safe to show.

Forced sign-out (see "Security"): when any `apiFetch` gets `SESSION_REVOKED` or
`ACCOUNT_REVOKED`, auth-client signs out of Neon Auth and goes to
`/login.html?reason=revoked` (in a browser that call never resolves, so callers
can't race the redirect). `requireUser()` also starts `watchSession()`, which
re-checks `/api/me` every 60 s and when the tab becomes visible (`reason=expired`
on a plain 401). `stopSessionWatch()` / `signOut()` stop it.

Password rules shown in the UI: at least 8 characters (and at most 128). 8 is
Better Auth's default minimum, which Neon Auth is built on; I could not find a
Neon page that states or lets you change it, so treat the exact number as
"default, unconfirmed". `auth-client` enforces 8 locally and maps Neon's
`PASSWORD_TOO_SHORT/LONG` to `WEAK_PASSWORD`.

Additions to the contract (all additive):

- `signUp` calls `/api/me` after Neon sign-up so the result is the real user
  (`pending`, or `approved` for a pre-added email). **If the Neon project
  requires email verification (recommended), sign-up creates no session**, so
  the result is `{ ok: true, needsVerification: true, user: <provisional pending
  user, id null> }`: show "check your inbox" instead of navigating. After the
  person verifies and signs in, the first `/api/me` links/creates the row.
- `resendVerificationEmail({ email })` -> `{ ok }`.
- `postSignInDestination(user, search)` -> `/app.html`, `/pending.html`, or the
  `?next=` path (same-origin only, and only for approved users); `safeNext(next)`.
- `apiFetch` resolves (never throws) to `{ ok, status, data, error }`: `data` is
  the parsed JSON body (or null), `error = { code, message }` when `!ok` (code =
  server `details.code` such as `NOT_APPROVED` / `NOT_ADMIN` / `LAST_ADMIN`, else
  `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INVALID`,
  `RATE_LIMITED`, `SERVER`, `NETWORK`). `path` may omit the `/api` prefix. A
  plain-object `body` is sent as JSON; strings/Blob/ArrayBuffer/FormData go
  as-is (xlsx upload: pass the bytes plus `headers: { 'X-Filename': name }`).
  A 401 triggers one token refresh and retry.
- Password-reset links land on `/login.html?view=reset&token=<token>`
  (`requestPasswordReset` passes `redirectTo = <origin>/login.html?view=reset`;
  Better Auth appends `?token=`; on failure it appends `?error=INVALID_TOKEN`
  instead). The login page should also accept `#token=`. The server only
  accepts a `redirectTo` on its own origin (or `APP_ORIGIN`), otherwise it
  substitutes `<origin>/login.html?view=reset`.

### Password reset & pre-added accounts

Pre-added (seeded) accounts **cannot reset their password themselves**; an
admin handles them. Enforcement is server-side: `requestPasswordReset` goes
through our `POST /api/auth/password-reset` (not straight to Neon Auth), which
only triggers Neon Auth's reset email when `app_users.source = 'signup'`, and
returns the same generic 200 either way (and pads timing). **Neon Auth's own
`request-password-reset` endpoint cannot be locked down**: the management API
(email/password config, plugins, email provider, domains) has no switch to disable
reset or hook it per user, and it is a public Better Auth route. So the
refusal holds for everything that goes through our UI/API; someone calling Neon's
endpoint directly with a pre-added email can still get a reset email (it only goes
to the mailbox owner). If that residual risk matters, the fix is to self-host
Better Auth instead of the managed service. An admin "resets" a pre-added account
by deleting that auth user in the Neon console (Auth -> Users); the person signs
up again with the same email and verifies it, which re-links the existing
approved row. The UI should show one generic message:
"If that account can reset its password, a link is on its way."

The login page can't know an account's source before sign-in, so it doesn't
need to; `user.source` is available after sign-in.

## Auth (decision record)

Researched against the Neon docs, 2026-10. "Neon Auth" is now **Managed Better
Auth** (Better Auth ~1.4 as a managed REST service over your own Neon database;
the Stack-Auth based product is `auth-legacy`). Users, sessions and credentials
live in the `neon_auth` schema (`neon_auth."user"` has `id`, `email`,
`"emailVerified"`, ...); our `app_users` is separate and linked by
`auth_user_id = neon_auth.user.id`.

- **Browser:** `createAuthClient(VITE_NEON_AUTH_URL)` from `@neondatabase/auth`
  (dependency added; lazy-loaded, ~325 kB chunk). Sign-in sets an HttpOnly session
  cookie on the Neon Auth host; `authClient.token()` returns a 15-minute EdDSA JWT.
- **Our API:** `Authorization: Bearer <jwt>` is verified in `server/auth.js` with
  `jose` against `<NEON_AUTH_URL>/.well-known/jwks.json`, issuer = the origin of
  `NEON_AUTH_URL`. Claims used: `sub`, `email`, `emailVerified`, `iat`, `exp`. Every
  request re-reads `app_users`, so approving/disabling takes effect immediately.
- **Server API:** `getAuthContext(req)` -> `{ identity, user } | null`;
  `requireUser(req, { allowPending })` (pending/rejected also allowed when
  `allowPending`, otherwise `approved` only; `disabled` is refused either way;
  401/403 `HttpError`), `requireApprovedUser(req)`, `requireAdmin(req)` return the
  `app_users` row. Error `details.code`s: 401 `SESSION_REVOKED` (token issued at or
  before `app_users.sessions_revoked_at`); 403 `NOT_APPROVED` (+ `status`),
  `NOT_ADMIN`, `EMAIL_NOT_VERIFIED`, `ACCOUNT_REVOKED` (status `disabled`, /api/me
  included); 429 `RATE_LIMITED` (+ `Retry-After` header). Also exported:
  `isRevoked(user, identity)`, `endNeonSessions(authUserId)`.
- **Linking rule:** an unverified email is refused before any lookup: 403
  `EMAIL_NOT_VERIFIED` and **no `app_users` row is created**. Verified: match by
  `auth_user_id`, then by email (re-links a pre-added or re-signed-up row); no row at
  all -> new `pending` signup row.
- **Email verification:** Neon supports requiring it (`require_email_verification`,
  console "Verify at Sign-up"). It must be ON in production; it makes the linking
  rule airtight and means admins approve real mailboxes. Verification *links*
  need a custom email provider (the shared provider only does OTP codes, which our
  UI does not implement), so set up an email provider too.
- **Pre-added accounts:** Neon's management API cannot create a user with a password
  or send an invite (create-user takes only email + name). So `npm run seed:users`
  and the admin CMS create approved `app_users` rows; the person signs up with
  that email, verifies it, and the first verified sign-in links the row.
- **Open sign-up stays on** in Neon (students self-register); the gate is the
  `pending` status, enforced on every API call.

Sources: neon.com/docs/auth/overview, /docs/auth/authentication-flow,
/docs/auth/guides/plugins/jwt, /docs/auth/guides/email-verification,
/docs/auth/guides/password-reset, /docs/reference/api/auth/update-neon-auth-email-and-password-config,
/guides/react-neon-auth-hono.

### Setup checklist (Neon + Vercel)

1. Neon console: create the project, **Auth -> Enable Neon Auth** (Managed Better
   Auth) on the `main` branch.
2. Auth settings: turn **on** "Verify at Sign-up" (require email verification,
   method `link`); configure a **custom email provider** (SMTP/Resend) so verification
   and reset links work; keep email+password enabled; no social providers needed.
3. Auth -> Domains / trusted origins: add the production URL (and preview domains
   if used); enable "allow localhost" for local dev.
4. Copy the **Auth URL** (Auth -> Configuration) into `NEON_AUTH_URL` and
   `VITE_NEON_AUTH_URL`; copy the Postgres connection string into `DATABASE_URL`.
5. Vercel -> Settings -> Environment Variables: set `DATABASE_URL`,
   `NEON_AUTH_URL`, `VITE_NEON_AUTH_URL` (Production + Preview), optionally
   `ADMIN_EMAILS`, `APP_ORIGIN`. `VITE_*` values are baked in at build time: redeploy
   after changing them.
6. Locally: copy `.env.example` to `.env.local`, then `npm run migrate`,
   `ADMIN_EMAILS=you@fast.edu.pk npm run seed:users`, sign up on the site with
   that email and verify it: you are the first admin.
7. Local dev: `npm run dev:api` (port 8787) and `npm run dev` (Vite proxies `/api`).

### `pending.html` stable element ids

`#pending-message` (explanatory text), `#pending-status` (badge; `data-status`
= pending|rejected|disabled|loading), `#signout-btn`. The page polls `/api/me`
and replaces itself with `/app.html` once approved.

## HTTP API

All responses are JSON. Errors: `{ "error": "message", "details"?: any }` with
401 (not signed in), 403 (not approved / not admin), 404, 409, 413, 422.

### Auth / users (platform agent)

- `GET /api/me` -> `200 { user }` | `401` (`details.code: 'SESSION_REVOKED'` when an admin signed them out) | `403 { details.code: 'EMAIL_NOT_VERIFIED' | 'ACCOUNT_REVOKED' }` (see Auth, Security). Creates/links the `app_users` row on
  first call after sign-up (idempotent). Works for pending users too.
  `user = { id, email, displayName, role: 'student'|'admin', status: 'pending'|'approved'|'rejected'|'disabled', source: 'signup'|'preadded' }`
- `POST /api/auth/password-reset` `{ email, redirectTo }` -> `200 { ok: true }` always.
- `GET /api/admin/users?status=pending` (admin) -> `{ users: [user + createdAt, approvedAt] }`
- `POST /api/admin/users` (admin) `{ email, displayName, role }` -> pre-add; `201 { user }`
- `PATCH /api/admin/users/:id` (admin) `{ status?, role?, displayName?, revokeSessions? }` -> `{ user }`.
  `status: 'disabled'` = **revoke access**: also signs the person out everywhere at once
  (so does any move away from `approved`). `revokeSessions: true` = force sign-out only.
  An admin cannot revoke their own access (409 `SELF_LOCKOUT`). See "Security".

### Timetables & schedules (timetable-data agent)

- `GET /api/timetables` (approved) -> `{ timetables: [{ id, department, semester, title, template, sectionCount, isPublished, uploadedAt }] }`
  (students see published only; admins see all)
- `GET /api/timetables/:id` (approved) -> `{ timetable: {...as above}, sections: [...] }`
  where `sections` has **the same shape `app.js` builds today from `parseWorkbook()`**,
  so the front end change is "fetch instead of parse".
- `POST /api/timetables` (admin) body = raw xlsx bytes, headers
  `Content-Type: application/octet-stream`, `X-Filename: <name>` ->
  `201 { timetable, warnings }`; `422` if it can't be parsed. Stored unpublished.
- `PATCH /api/timetables/:id` (admin) `{ department?, semester?, title?, isPublished? }`
- `DELETE /api/timetables/:id` (admin)
- `GET /api/schedules/:timetableId` (approved) -> `{ schedule: { sectionKeys: ['CODE|SECTION', ...], colorAssignments: {...}, updatedAt } | null }`
- `PUT /api/schedules/:timetableId` (approved) same body -> `{ schedule }`

## Database (core shape; agents may add columns/indexes)

- `app_users(id uuid pk, auth_user_id text unique null, email citext unique, display_name, role, status, source, created_at, approved_at, approved_by)`
  - Pre-added rows have `auth_user_id` NULL until that person first signs in.
  - **Link a sign-in to a pre-added row only when the email is verified by
    Neon Auth**, or anyone could claim a pre-added (pre-approved) email by
    signing up with it.
- `timetables`, `sections`, `meetings` (002) - see timetable-data agent.
- `saved_schedules(user_id, timetable_id, section_keys text[], color_assignments jsonb, updated_at, pk(user_id, timetable_id))` (003).
- `room_finder_accounts`, `room_finder_sessions` (004) - see "Free Room Finder" below.

## Free Room Finder (separate module, separate login)

The room finder from the standalone `free-room-finder` repo, folded in as its
own module at `/rooms/`. It shows which rooms are free right now or for a
chosen slot, merging **every published timetable** into one room map (a room
is free only if no department has booked it).

**It has its own login, and only accounts an admin created can use it.**

- Accounts live in `room_finder_accounts` (username + scrypt hash), not in
  Neon Auth and not in `app_users`. There is **no sign-up** and no
  self-service reset. A Timetable Decoder login does not open the Room Finder,
  and a Room Finder login does not open the timetable tool (both directions
  are tested in `tests/rooms.test.js`).
- Session: a random token in an `rf_session` cookie (HttpOnly,
  SameSite=Strict, `Path=/api/rooms`, Secure on https, 7 days). Only its
  SHA-256 is stored, in `room_finder_sessions`. Every request re-reads the
  account, so disabling it signs it out at once. A password reset ends all of
  its sessions.
- Login is rate limited per IP+username (10 / 15 min) and per IP (50 / 15 min)
  via `auth_rate_limits`. Unknown usernames take as long as wrong passwords. A
  disabled account is reported as such only after a correct password.
  State-changing calls must be `application/json` (CSRF, with SameSite).

Code: `server/rooms/auth.js` (hashing, sessions, cookies),
`server/rooms/accounts.js` (create / update / delete, shared by the CLI and
the admin API), `rooms/index.html` + `src/rooms/pages/app.js` (the finder),
`rooms/login.html` + `src/rooms/pages/login.js`, `src/rooms/client.js`
(browser client; does not use `src/auth-client.js`), `src/rooms/rooms.css`.

### Managing accounts

```
npm run rooms:accounts -- add <username> [--name "Full Name"]   # prints a generated password once
npm run rooms:accounts -- reset-password <username>              # prints a new one; signs them out
npm run rooms:accounts -- disable <username> | enable <username> | remove <username>
npm run rooms:accounts -- list
```

Usernames are 3-64 characters (letters, digits, `. _ @ + -`; an email
address works). People sign in at `/rooms/login.html` and can change their
password from the finder's header. Passwords are never taken on the command
line.

### API

- `GET /api/rooms/session` -> `{ account: { id, username, displayName } }` | 401 `ROOMS_SIGNED_OUT`
- `POST /api/rooms/session` `{ username, password }` -> `{ account }` + cookie. 401
  `INVALID_CREDENTIALS`, 403 `ACCOUNT_DISABLED`, 429 `RATE_LIMITED`, 415 if not JSON.
- `PATCH /api/rooms/session` `{ currentPassword, newPassword }` -> `{ account }`; signs out
  the account's other sessions. 403 `INVALID_CREDENTIALS`, 422 `WEAK_PASSWORD`.
- `DELETE /api/rooms/session` -> `{ ok: true }`, cookie cleared.
- `GET /api/rooms/data` (Room Finder session) -> `{ timetables: [{ id, department, semester,
  title, explicitDurations, sections }] }` for every **published** timetable; `sections` is
  the `GET /api/timetables/:id` shape. Null `durMin` is estimated client-side (80 theory /
  150 lab, adjustable on the page) using the meeting's `isLab`.
- Admin (timetable-tool admins, Neon Auth JWT), one function to stay under Vercel's cap:
  - `GET /api/admin/room-accounts` -> `{ accounts: [{ id, username, displayName, status, createdAt, passwordChangedAt, lastLoginAt }] }`
  - `POST /api/admin/room-accounts` `{ username, displayName?, password? }` -> `201 { account, temporaryPassword? }`
    (a password is generated and returned once when none is given)
  - `PATCH /api/admin/room-accounts?id=<uuid>` `{ status?: 'active'|'disabled', displayName?, resetPassword?: true, password? }`
    -> `{ account, temporaryPassword? }`
  - `DELETE /api/admin/room-accounts?id=<uuid>` -> `{ ok: true }`
  - Each write adds a `room.create` / `room.update` / `room.delete` audit entry (never the password).

## Security

Every authenticated API request runs these checks, in order (`server/auth.js`):

1. A well-formed `Authorization: Bearer <jwt>` (no header -> 401, nothing else runs).
2. JWT signature (Neon JWKS, https-only in production), allowed algorithms, issuer,
   `exp`, `iat` present / not in the future / not older than 1 h, `sub` + `email`.
3. Email verified, or 403 `EMAIL_NOT_VERIFIED`. **No `app_users` row is created for
   an unverified address**, so nobody can squat someone else's email and get it approved.
4. Per-account rate limit.
5. The `app_users` row is re-read (never cached).
6. Revocation: a token issued at or before `app_users.sessions_revoked_at` -> 401 `SESSION_REVOKED`.
7. `disabled` -> 403 `ACCOUNT_REVOKED` everywhere (including `/api/me`); anything but
   `approved` -> 403 on data routes.
8. Admin routes re-check `role = 'admin'` on that same fresh row.

**Revoking access.** An admin presses *Revoke access* (status `disabled`) or *Force
sign-out* (`revokeSessions`). The server sets `sessions_revoked_at = now()` (every JWT
the person holds dies on its next use) and deletes their rows in `neon_auth.session`
(so the browser cannot mint a new token without signing in). In the browser,
`apiFetch` sees `SESSION_REVOKED` / `ACCOUNT_REVOKED`, signs out of Neon Auth and goes
to `/login.html?reason=revoked`; `requireUser()` also re-checks `/api/me` every minute
and whenever the tab becomes visible, so an idle open tab is logged out within a minute.
A revoked person who signs in again gets `ACCOUNT_REVOKED` until access is restored.

**Rate limits** (`server/rate-limit.js`; fixed windows, in memory per instance *and* in
`auth_rate_limits` across instances; 429 with `Retry-After` and `details.code: 'RATE_LIMITED'`):

| what | key | limit |
|---|---|---|
| requests with no credentials | IP | 300 / min (memory) |
| invalid / forged / expired tokens or Room Finder cookies | IP | 60 / 5 min |
| every authenticated request | account | 300 / 5 min |
| writes (POST/PUT/PATCH/DELETE) | account | 120 / 5 min |
| timetable uploads | admin | 20 / 10 min |
| Room Finder requests | account | 300 / 5 min |
| password reset | IP+email / IP / email | 3 / 15 min, 30 / 15 min, 5 / h |
| Room Finder login | IP+username / IP / username | 10 / 15 min, 50 / 15 min, 30 / 15 min |

Signed-in traffic is limited per account rather than per IP, because a whole campus can
share one NAT address. IPs come from `X-Forwarded-For` only on Vercel (which overwrites
it) or with `TRUST_PROXY=1`; otherwise the socket address. IPv6 is grouped by /64.

**Other measures:** request bodies must be JSON objects (400 otherwise); password-reset
links only point at `APP_ORIGIN` / Vercel's own deployment URLs on Vercel, never at a
request header; CSP (`script-src 'self'`, `frame-ancestors 'none'`, Neon Auth as the
only extra `connect-src`), HSTS, COOP/CORP and nosniff headers in `vercel.json`.

## Admin CMS (`/cms.html`)

A dashboard-style admin console in the System Solutions theme (`brand.css` +
`src/styles/cms.css`): a grouped sidebar from 1024px up, an off-canvas drawer
below that, and tables that collapse into cards on phones. Vanilla JS modules
in `src/cms/` (`main.js` = shell + hash router, `ui.js` = DOM/dialog/API
helpers, `charts.js` = hand-built SVG charts, `format.js` = pure formatters
tested in `tests/cms-format.test.js`, `screens/*.js` = one file per screen).
Gated with `requireUser({ role: 'admin' })`; every call is re-checked server-side.

| route | screen | reads | writes |
|---|---|---|---|
| `#/` | Dashboard: KPIs, 30-day sign-ups / daily-active charts, approval queue, top timetables, Room Finder usage, recent activity | `GET /api/admin/stats` | `PATCH /api/admin/users/:id` |
| `#/users` | Users: status tabs, search, approve/reject/disable, edit name/role/status, pre-add, approve-all | `GET /api/admin/users` | `PATCH /api/admin/users/:id`, `POST /api/admin/users` |
| `#/timetables` | Upload (drag-and-drop), publish/unpublish, edit, delete | `GET /api/admin/timetables` | `POST/PATCH/DELETE /api/timetables*` |
| `#/timetables/<id>` | Stats, parser notes, file info, sections with students per section | `GET /api/admin/timetable?id=` | same as above |
| `#/demand?t=<id>` | Course demand from saved schedules: top courses/sections/teachers, weekday load, schedule sizes, unpicked courses | `GET /api/admin/insights?timetableId=` | - |
| `#/rooms` | Room Finder accounts: create (one-time password), reset password, rename, disable, delete | `GET /api/admin/room-accounts` | `POST/PATCH/DELETE /api/admin/room-accounts` |
| `#/activity` | Audit log: search, filter by action or group, paging, field-level diffs | `GET /api/admin/activity?q=&action=&page=` | - |

The five `GET /api/admin/{stats,insights,activity,timetables,timetable}` reads
share one Vercel function, `api/admin/[screen].js` (handlers in
`api/admin/_cms.js`, tests in `tests/cms.test.js`), to stay under the
12-function Hobby cap. `/api/admin/users` and `/api/admin/room-accounts` are
static files and win over the dynamic route.

Data (`db/migrations/005_admin_cms.sql`, helpers in `server/activity.js`):

- `app_users.last_seen_at` + `user_activity_days(user_id, day)`: written by
  `touchLastSeen()` from `getAuthContext()` at most once per 5 minutes per
  user; days are `Asia/Karachi`. Powers "active today / this week / this month"
  and the daily-active chart. It counts API use, so the trend starts from when
  the migration is applied.
- `audit_log`: `recordAudit(actor, action, {type, id}, summary, details)`.
  Written after user pre-add/PATCH (`user.approve|reject|disable|reset|role|rename|preadd`),
  timetable upload/PATCH/DELETE (`timetable.upload|publish|unpublish|edit|delete`)
  and Room Finder account writes (`room.create|update|delete`). Both helpers
  fail soft: a logging error never fails the request.
- Charts are single-series, drawn in brand 600 `#0a82ad` (passes 3:1 on white;
  brand 500 does not), each with a "View As Table" fallback.
