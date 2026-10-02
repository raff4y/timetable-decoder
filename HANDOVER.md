# Handover: Timetable Decoder

## What this is now

A login-gated web app for FAST-NUCES students. Admins upload a department's
Excel timetable; the server parses and stores it (Neon Postgres). Approved
students sign in (Neon Auth), pick a published timetable, choose sections, and
get a weekly schedule image. Their chosen sections are saved per account.

It started as a static, client-only page that parsed the xlsx in the browser.
That is gone: there is a backend now, and the parser lives in `server/parser/`.

**Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first.** It is the binding
contract: auth decision record, HTTP API, database shape, setup checklist and
who owns which files. [README.md](README.md) has the local-dev and deploy steps.

## Where things are

| area | files |
|---|---|
| Timetable tool | `app.html`, `app.js`, `styles.css`; logic split into `src/app/model.js` (pure), `canvas.js` (drawing), `saver.js` (debounced autosave) |
| Admin CMS | `cms.html`, `src/cms/**`, `src/styles/cms.css`, read API in `api/admin/_cms.js` (`admin.html` only redirects here) |
| Auth + API calls from the browser | `src/auth-client.js` (`requireUser`, `apiFetch`, `signOut`) |
| API | `api/timetables/*`, `api/schedules/*`, `api/admin/users*`, `api/me.js` |
| Parser | `server/parser/` (flat list + period grid templates) |
| Public pages | `index.html`, `login.html`, `pending.html` (owned by the design session) |

## How the timetable tool works

1. `requireUser()` gates the page; nothing renders until it resolves.
2. `GET /api/timetables` fills the picker (grouped by department, labelled by
   semester). The last choice is remembered in `localStorage`.
3. Choosing one fetches `GET /api/timetables/:id` (sections) and
   `GET /api/schedules/:id` (the saved selection) together. Saved keys
   (`CODE|SECTION`) that no longer exist are ignored; colours are restored so they
   never re-cycle.
4. Every selection change is debounced (800 ms) into `PUT /api/schedules/:id`,
   one request at a time, with a saved / saving / failed indicator. If the saved
   schedule could not be loaded, autosave stays off so an empty selection can't
   overwrite it.
5. A meeting with `durMin: null` uses the theory (80) / lab (150) inputs;
   `timetable.explicitDurations` disables those inputs.

## Behaviour worth keeping

- A theory course and its lab share a colour (matched by name with a trailing
  "Lab" stripped); slots are never reused when sections are removed.
- Lab detection: the stored `isLab` flag, i.e. name matches `\blab\b` or the room
  matches `lab`. Do not rely on course-code prefixes.
- The PNG is always drawn with the light palette so it looks right on its own.
- All data from the API or database is rendered with `textContent` / DOM nodes,
  never `innerHTML` (a test enforces this for the page scripts).

## Tests

`npm test` runs everything (PGlite in memory, no database needed).
`tests/parser-faithful.test.js` compares the server parser with the original v1
browser parser, frozen in `tests/fixtures/legacy-app.js` (with the SheetJS 0.18.5
build it shipped with). It uses the real `*.xlsx` exports in the repo root when
present and skips those cases otherwise.

## Known limits and ideas

- Per-block manual duration editing is out of scope; only the two global
  estimate inputs exist.
- Uploads are capped at 4 MB (Vercel's request body limit).
- Class-length estimates are not saved with a schedule (only sections and colours).
- Page gating is client-side; the real boundary is the server-side checks on every
  `/api` call.
