# Timetable Decoder

A timetable tool for FAST-NUCES students. Pick your department's timetable,
search or bulk-paste your course sections, and download a clean PNG of your
personal weekly schedule - labs, rooms and instructors included.

The app is login-gated. An admin uploads each department's official Excel
export once; the server parses it and stores it in Postgres. Students sign in,
pick a published timetable, and their chosen sections are saved to their account
so they come back on any device.

- **Front end:** Vite multi-page app, vanilla JS modules, no framework.
- **API:** Vercel Node functions in `api/` (also run locally by `scripts/dev-server.mjs`).
- **Database + auth:** Neon Postgres and Neon Auth (managed Better Auth).

The contract between the pieces (auth decision record, HTTP API, database shape,
file ownership) lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Pages

| page | who | what |
|---|---|---|
| `/` | public | landing page |
| `/login.html` | public | sign in, sign up, password reset |
| `/pending.html` | signed in, not approved | waiting for approval / rejected / disabled |
| `/app.html` | approved users | the timetable tool |
| `/cms` | admins | admin CMS (own login at `/cms/login`): approve sign-ups, manage users, pre-add accounts, upload and publish timetables, Room Finder accounts, statistics (`/admin.html` and `/cms.html` redirect here) |

## Run it locally

You need Node 20+ and a Postgres database (a free Neon project works; the
migrations need `citext`, which Neon provides). Neon Auth must be enabled on the
project; see the setup checklist in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
npm install
cp .env.example .env.local      # then fill in DATABASE_URL, NEON_AUTH_URL, VITE_NEON_AUTH_URL
npm run migrate                 # applies db/migrations/*.sql
ADMIN_EMAILS=you@fast.edu.pk npm run seed:users   # pre-approve yourself as admin
npm run dev:api                 # API on http://localhost:8787
npm run dev                     # Vite on http://localhost:5173, proxies /api to the API
```

Open <http://localhost:5173/>, sign up with the email you seeded and verify it:
that first sign-in links to the pre-approved admin row. More accounts can be
seeded from a CSV/JSON file (`npm run seed:users -- users.csv`) or pre-added on
the admin CMS (`/cms`).

Then open the admin CMS (`/cms`), upload a department timetable (`.xlsx`, up to 4 MB),
check the parse warnings, and publish it. It appears in the picker on `/app.html`.

Tests and a production build:

```
npm test            # parser, API, auth client and front-end logic tests (PGlite, no database needed)
npm run build       # Vite build into dist/
```

## Deploy (Vercel)

`vercel.json` sets the Vite framework preset, the `dist/` output and the API
function settings. Import the repo on Vercel, then set these environment
variables (Production and Preview): `DATABASE_URL`, `NEON_AUTH_URL`,
`VITE_NEON_AUTH_URL`, and optionally `ADMIN_EMAILS` / `APP_ORIGIN`. The `VITE_*`
value is baked in at build time, so redeploy after changing it. Run
`npm run migrate` against the production database before the first deploy.

## How the timetable tool behaves

- Two export templates are parsed (on the server, in `server/parser/`) and
  auto-detected:
  - **Flat list** (e.g. EE department): a "List of Courses" sheet with
    Code/Course/Section/Teacher/Day/Time/Room rows.
  - **Period grid** (e.g. FAST School of Computing / Management): a
    rooms-by-periods grid in 10-minute columns, joined with the course-list
    sheet(s) for full titles, codes and instructors. The parser is deliberately
    forgiving about the many dialects these files come in.
- The flat template lists start times but not durations, so class lengths are
  estimated: 80 min for theory, 150 min for labs. Both are adjustable under
  "Advanced: class length estimates". When a timetable states exact durations
  (the grid template), the estimates are disabled.
- Choosing sections autosaves (about 0.8 s after the last change) to your
  account; a small indicator next to "Your sections" shows saving / saved / not
  saved. The last timetable you used is remembered in `localStorage`.
- A course and its lab render in the same colour; colours never re-cycle when
  you add or remove sections (they are saved with the schedule). Overlapping
  classes are flagged and drawn side by side.
- "Browse the catalog" opens a dialog with filterable Courses, Teachers and
  Sections views; every row has an Add button.
- Every instructor gets a "Reviews" link to
  [NUCESRate](https://nucesrate.vercel.app): a plain outbound link to that
  site's own search page, so nothing about your schedule is shared with it. The
  campus dropdown in the catalog narrows the search and is remembered in
  `localStorage`.

## Repository layout

```
app.html, app.js          the timetable tool (entry module)
cms/index.html, login.html admin CMS at /cms and its login at /cms/login; logic in src/cms/
src/app/                  pure logic (model, canvas drawing, autosave)
src/auth-client.js        sign-in/out, token handling and apiFetch for every page
api/                      Vercel functions (timetables, schedules, users, auth)
server/                   db, http and auth helpers; the xlsx parser in server/parser/
db/migrations/            plain SQL migrations, applied by scripts/migrate.mjs
tests/                    node:test suites (tests/fixtures/legacy-app.js freezes the v1 browser parser)
```

`tests/parser-faithful.test.js` checks the server parser against the original v1
browser parser, kept frozen in `tests/fixtures/legacy-app.js`. It uses the real
department exports (`*.xlsx` in the repo root, git-ignored) when they are
present and skips those cases otherwise.
