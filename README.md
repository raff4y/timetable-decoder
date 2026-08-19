# Timetable Decoder

This is for FAST NUCES students help to decode their messy timetables.

Upload the department's official Excel timetable export (the workbook with a
"List of Courses" sheet), search or bulk-paste your course sections, and
download a clean PNG of your personal weekly schedule - labs, rooms, and
instructors included. Everything runs in the browser; the file is never
uploaded anywhere.

## Run it

No build step. Serve the folder over http:

```
python -m http.server 8000
```

then open <http://localhost:8000/>. Any static server works.

## Deploy

It's a plain static site (HTML + CSS + one vendored JS file), so any static
host works. On Vercel, import the repo and deploy with no configuration:

- Framework preset: **Other**
- Build command: *(leave empty)*
- Output directory: *(leave empty - the repo root is served as-is)*
- Install command: *(leave empty)*

Or from the CLI:

```
npx vercel --prod
```

## Notes

- Two export templates are supported and auto-detected:
  - **Flat list** (e.g. EE department): a "List of Courses" sheet with
    Code/Course/Section/Teacher/Day/Time/Room rows.
  - **Period grid** (e.g. FAST School of Computing, FAST School of Management):
    a rooms-by-periods grid in 10-minute columns, joined with the course-list
    sheet(s) for full course titles, codes, and instructor names.
- The flat template lists start times but not durations, so class lengths are
  estimated: 80 min for theory, 150 min for labs (the department's standard
  period grid). Both are adjustable under "Advanced: class length estimates".
  The grid template encodes exact durations, so the estimates are disabled.
- Grid files vary a lot between departments, and the parser is deliberately
  forgiving about it:
  - Period headers in any dialect - `08:30-10:00`, `8:30 AM to 9:50 AM`,
    `6:00 P.M.to 9:00 PM`.
  - A cell reading `Course Title (SECTION) Instructor`, with or without a
    colon, with two co-scheduled courses joined by `&` or `/`, or with a
    mistyped bracket.
  - A time typed inside a cell (`... 4:00 to 6:00 Ms. X`) wins over the block's
    drawn width - hand-drawn blocks are often a column off. Where a file states
    a slot in words in one cell and draws it 10 minutes early in another, the
    near-misses are snapped onto the stated time.
  - Class length comes from the typed time, else the merged block's width, else
    the rest of the period - so a 6-9pm MBA class isn't drawn as 80 minutes.
  - Grid and course-list sheets rarely word a course identically, so titles
    match after dropping qualifiers like "(Elective)", lab subsections
    (`BAF-1A1`) fall back to their parent row (`BAF-1A`), and a longest-prefix
    match catches the rest. Courses missing from the list entirely keep their
    grid title in place of a code.
- A course and its lab render in the same color; overlapping classes are
  flagged and drawn side by side.
- "Browse the catalog" is a button in the header that opens a full-screen
  dialog with three filterable views - Courses, Teachers, and Sections (each
  section grouped with its lab sub-sections, e.g. `BAF-1A` with `BAF-1A1`).
  Every row has an Add button that puts that section straight on the timetable,
  and the Added state stays in sync with the picker behind the dialog.
- Every instructor gets a "Reviews" link to their student reviews on
  [NUCESRate](https://nucesrate.vercel.app). These are plain outbound links to
  that site's own search page - no API, no key, and nothing about the
  schedule leaves the browser. Honorifics are stripped from the timetable name
  before searching (their records carry their own), and role placeholders like
  "Lab Engineer - II" are skipped. The campus dropdown in the catalog dialog
  narrows the search for common names; it's remembered in `localStorage`.
- `vendor/xlsx.full.min.js` is SheetJS `xlsx@0.18.5`, vendored so the app
  works offline.
