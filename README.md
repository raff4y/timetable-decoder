# Timetable Decoder

This is for FAST NUCES students help to decode their messy timetables.

Upload the department's official Excel timetable export (the workbook with a
"List of Courses" sheet), search or bulk-paste your course sections, and
download a clean PNG of your personal weekly schedule — labs, rooms, and
instructors included. Everything runs in the browser; the file is never
uploaded anywhere.

## Run it

No build step. Serve the folder over http (the sample-file button uses
`fetch()`, which browsers block on `file://` pages):

```
python -m http.server 8000
```

then open <http://localhost:8000/>. Any static server works.

## Deploy

It's a plain static site (HTML + CSS + one vendored JS file), so any static
host works. On Vercel, import the repo and deploy with no configuration:

- Framework preset: **Other**
- Build command: *(leave empty)*
- Output directory: *(leave empty — the repo root is served as-is)*
- Install command: *(leave empty)*

Or from the CLI:

```
npx vercel --prod
```

`EE Time Table (Fall 2026) v1.0.xlsx` is committed on purpose — the "Try the
sample" button fetches it at runtime. Every other timetable export is
gitignored, so dropping a file into this folder while working never puts
someone's schedule in the repo.

## Notes

- Two export templates are supported and auto-detected:
  - **Flat list** (e.g. EE department): a "List of Courses" sheet with
    Code/Course/Section/Teacher/Day/Time/Room rows.
  - **Period grid** (e.g. FAST School of Computing): a "Combined TT"
    rooms-by-periods grid in 10-minute columns, joined with the per-department
    course-list sheets for full course titles, codes, and instructor names.
- The flat template lists start times but not durations, so class lengths are
  estimated: 80 min for theory, 150 min for labs (the department's standard
  period grid). Both are adjustable under "Advanced: class length estimates".
  The grid template encodes exact durations, so the estimates are disabled.
- A course and its lab render in the same color; overlapping classes are
  flagged and drawn side by side.
- A "Browse the catalog" section lists every course offered and every
  teacher's course load, filterable, with click-through to the section picker.
- Every instructor gets a "Reviews" link to their student reviews on
  [NUCESRate](https://nucesrate.vercel.app). These are plain outbound links to
  that site's own search page — no API, no key, and nothing about the
  schedule leaves the browser. Honorifics are stripped from the timetable name
  before searching (their records carry their own), and role placeholders like
  "Lab Engineer - II" are skipped. The campus dropdown in the catalog panel
  narrows the search for common names; it's remembered in `localStorage`.
- `vendor/xlsx.full.min.js` is SheetJS `xlsx@0.18.5`, vendored so the app
  works offline.
