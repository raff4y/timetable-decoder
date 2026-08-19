# Handover: Timetable Decoder web app

## What this project is

A static, fully client-side web app for FAST-NUCES students. Flow: upload the
department's official Excel timetable export → app parses it in-browser →
student searches/picks their course sections (or bulk-pastes codes+sections) →
app renders their personal weekly schedule (with labs, rooms, instructor
names) onto a canvas → student downloads it as a PNG.

**No backend.** The xlsx file never leaves the browser. This is intentional —
keep it that way.

## Status: HTML + CSS done, app.js NOT YET WRITTEN

Files that exist and are finished:
- `index.html` — full page structure, all element IDs the JS needs to hook
  into are already there (list below).
- `styles.css` — full styling, light/dark aware via `prefers-color-scheme`,
  uses design tokens (see "Design tokens" below).
- `vendor/xlsx.full.min.js` — SheetJS (npm `xlsx@0.18.5`, the `dist/xlsx.full.min.js`
  UMD build), vendored so the app works offline with no CDN dependency. It's
  already `<script src="vendor/xlsx.full.min.js">`'d in `index.html` before
  `app.js`, so `XLSX` is a global by the time `app.js` runs.
- `EE Time Table (Fall 2026) v1.0.xlsx` — a real sample file, already sitting
  in the repo root, used for the "Try the sample EE timetable" button and for
  testing.

**`app.js` is the only thing left to write.** Everything below is the spec for
it, derived from actually inspecting the sample xlsx with openpyxl (Python)
before any code was written, so the data-shape assumptions here are verified,
not guessed.

## The source file's structure (verified via openpyxl)

The workbook has 2 sheets:

1. **`List of Courses`** — this is the ONE the app should parse. It's a flat
   table, not a grid. Header row is **row 3** (1-indexed), columns **A–H**:
   `Code | Course | Section | Teacher | Day | Time | Room | Batch`.
   Data starts row 4. Example rows:
   ```
   EE3012 | µP Interfacing and Programming | BEE-5A | Abeer Bashir | Tuesday  | 8:30am | D - 6 | 2024
   EE3012 | µP Interfacing and Programming | BEE-5A | Abeer Bashir | Thursday | 8:30am | D - 6 | 2024
   EL3012 | µP Interfacing and Programming - Lab | BEE-5A1 | Aliha Tanveer | Wednesday | 11:30am | Microprocessor Lab | 2024
   ```
   Each row = one weekly meeting occurrence of one section (so a course
   meeting twice a week produces two rows with the same Code+Section but
   different Day). There is **no end-time/duration column** — see the
   duration heuristic below for why that's OK.

   Don't hardcode "row 3" as the header row when parsing — **detect it** by
   scanning the first ~10 rows of the sheet for one containing cells that
   case-insensitively match `code`, `course`, `section`, `teacher`, `day`,
   `time`, `room` (batch is optional/not load-bearing). This sheet-template is
   used across FAST departments each semester, but don't assume the exact
   sheet name `List of Courses` either — some department files may name it
   slightly differently. Prefer: scan all sheets, pick the one whose header
   row best matches that column set. Fall back to sheet name containing
   "list" and "course" if header-scan is ambiguous.

2. **`Timetable <date>`** — a big visual cross-tab grid (rooms × 10-minute
   sub-columns × days), colored by batch, used by the university for the
   printed poster version. **The app does not need to parse this sheet.** It
   was only used during investigation (see next section) to figure out real
   class durations, since the flat sheet doesn't have them. Don't build a
   grid/color parser for it — SheetJS's free build doesn't reliably expose
   cell fill styles anyway, which is exactly why the flat sheet + a duration
   heuristic was chosen as the robust approach instead.

## Duration heuristic (already decided, already wired into the HTML)

The flat sheet gives start time but not duration. By reverse-engineering the
grid sheet's color blocks (see git history / this doc's derivation — not
worth re-deriving), real FAST periods are:
- **Theory classes: 80 minutes** (period grid runs 8:30, 10:00, 11:30, 1:00pm,
  2:30pm, 4:00pm — each 80 min with a 10 min gap between).
- **Labs: 150 minutes** (~2.5 hours).

These are already the `value=` defaults on `#theory-min` (80) and `#lab-min`
(150) number inputs in `index.html`, under the "Advanced: class length
estimates" `<details>` in the build panel. **app.js must read those two
inputs live** when computing block heights (don't hardcode 80/150 in JS —
let the user's current input values win, defaulting to what's already in the
HTML). Classify a meeting as a lab if the course **name** matches
`/\blab\b/i` (e.g. ends with "- Lab") OR the room matches `/lab/i` — don't
rely on code-prefix conventions (like `EE`→`EL`), they're not guaranteed to
hold across every department.

## Color-by-course heuristic (also already decided)

A theory course and its paired lab (e.g. "µP Interfacing and Programming" /
"µP Interfacing and Programming - Lab") should render in the **same color**,
so the schedule reads as "this is one course, in two blocks." Pair them by
**name**, not code: strip a trailing `- Lab` / `(Lab)` (case-insensitive) from
the course name to get a "base name" key; assign palette colors per unique
base-name key, in the order the student adds sections (first added = slot 1,
etc.) — never re-sort/re-cycle colors when the selection changes, per the
dataviz skill's categorical-color rule (a color, once assigned to a course in
this session, must not change if other courses are added/removed around it).

### Palette (validated, from the dataviz skill's `references/palette.md` — already run through the CVD/contrast validator, don't re-derive)

| slot | hue | light | dark |
|---|---|---|---|
| 1 | blue | `#2a78d6` | `#3987e5` |
| 2 | orange | `#eb6834` | `#d95926` |
| 3 | aqua | `#1baf7a` | `#199e70` |
| 4 | yellow | `#eda100` | `#c98500` |
| 5 | magenta | `#e87ba4` | `#d55181` |
| 6 | green | `#008300` | `#008300` |
| 7 | violet | `#4a3aa7` | `#9085e9` |
| 8 | red | `#e34948` | `#e66767` |

Use the **light** column values for the canvas fills regardless of the page's
own dark-mode CSS — the exported PNG is a standalone image (typically viewed
on a white background / shared / printed), so it should look right without
depending on system theme. (The page chrome around the canvas can still be
dark-mode aware via the CSS already written.) If a student selects more than
8 distinct base courses (rare — most take 5–7 per semester), cycle the
palette but lighten/darken alternate passes slightly so repeats are still
distinguishable; this is a fine edge-case fallback, not worth over-engineering.

For text-on-block contrast: pick white or near-black label text per block
based on a simple relative-luminance check against that block's fill color
(standard WCAG-style luminance formula), not a fixed color — several of the
palette hues (yellow, aqua, magenta) are light enough that white text would
fail on them.

## `index.html` element IDs app.js must wire up

Upload panel:
- `#file-input` (hidden file input), `#dropzone` (the clickable/draggable
  label wrapping it — needs dragover/dragleave/drop handlers too), `#load-sample-btn`
  (fetches `EE Time Table (Fall 2026) v1.0.xlsx` via `fetch()` from the repo
  root — it's same-origin, no CORS issue when served over http(s)), `#upload-status`
  (status text; toggle `.error`/`.success` classes on it).

Reveal-on-load: `#build-panel` and `#image-panel` start `hidden` — remove the
attribute once a file is successfully parsed.

Build panel:
- `#file-summary` (fill with something like "EE Department — Fall 2026 — 46
  courses found").
- `#course-search` (text input) → filters into `#search-results`. Render
  results using the existing CSS classes: `.result-group` (one per
  Code+Course+Section... actually group by Code+Course, i.e. one group per
  distinct course, containing its distinct sections as `.result-row`s) with
  `.result-group-head` (Code + course name, use `.rg-name` span for the name
  part), each `.result-row` containing `.result-row-main` >
  `.result-row-section` (section id) + `.result-row-meta` (teacher · days/times
  · room, condensed), and a `.result-row-add` button ("Add"/"Added" — toggle
  `.added` class on the row and button text on click to add/remove).
- `#quick-add-input` (textarea) + `#quick-add-resolve` (button) +
  `#quick-add-feedback` (div to append `.qa-ok`/`.qa-fail` lines into, one per
  parsed token, per the resolver spec below).
- `#selected-list` (`<ul>`) + `#selected-count` (badge) + `#empty-selected-hint`
  (toggle visibility opposite to whether the list is empty). Each `<li>` should
  use `.selected-item` > `.selected-swatch` (background = that course's
  assigned color) + `.selected-main` > `.selected-title` (Code · Section) +
  `.selected-meta` (course name · teacher · days/times) + `.selected-remove`
  button (×).
- `#conflict-banner` (hidden by default) + `#conflict-text` — show/fill when
  two selected meetings overlap in time on the same day; list the clashing
  pairs in a `<ul>` inside `#conflict-text`.
- `#theory-min` / `#lab-min` number inputs — read live, as described above.

Image panel:
- `#timetable-canvas` — the single source of truth for the rendered schedule.
  Draw directly here for the on-page preview (this is also visually the
  "image", not a separate DOM/CSS grid — deliberate choice to avoid having
  two parallel layout implementations to keep in sync).
- `#download-btn` — re-render at a higher device-pixel-ratio-equivalent scale
  (e.g. draw the same layout function into an offscreen canvas at 2–3× size)
  and trigger a download via `canvas.toBlob()` → object URL → temporary `<a
  download>` click. Suggested filename: something like
  `timetable-<first course code>.png` or just `my-timetable.png`.

## Suggested app.js internal shape

- `parseWorkbook(arrayBuffer) → { meta, sections }` where `meta` = whatever
  can be scraped for the summary line (department/semester if easily
  findable — there's a title cell like `'EE TIME TABLE & LIST OF COURSES [EE
  Department]'` in row 2 of the course-list sheet, worth regexing out the
  department name and "Fall 2026" if present, but don't block on it), and
  `sections` = array of `{ code, name, section, teacher, batch, meetings: [{day, startMin, room}] }`
  grouped from the flat rows by `code+section` (day/time strings parsed once
  into minutes-since-midnight; keep the raw label too for display).
- Global app `state` object: `{ sections: [...all parsed...], selected: Map<code+'|'+section, sectionObj>, colorAssignments: Map<baseNameKey, paletteIndex> }`.
- `resolveQuickAddToken(token, sections)` — token like `"EE3012-5A"` or
  `"EE3012 BEE-5A"` or `"EE3012-BEE-5A"`: extract a leading code-like
  substring (regex `[A-Za-z]{2,}\d{3,}` is a reasonable generic match, don't
  overfit to `EE####`), match case-insensitively against known codes; take
  the remainder (strip separators/whitespace/punctuation), match against that
  code's sections by case-insensitive equality first, then suffix match
  (remainder endswith → section, e.g. `"5A"` matching `"BEE-5A"`), then
  substring-contains as last resort. Return a clear ok/fail result per token
  so `#quick-add-feedback` can show per-line status.
- Time parsing: regex `/^(\d{1,2}):(\d{2})\s*([ap]m)/i` on strings like
  `"8:30am"`, `"12:00pm"`.
- Conflict detection: for each day, sort selected meetings by start time,
  flag any pair whose `[start, start+duration)` ranges overlap.
- Canvas renderer: `renderTimetable(ctx, selectedMeetings, {theoryMin, labMin, colorFor, scale})`
  — x-axis = weekdays present in selection (always show Mon–Fri even if some
  are empty; add Saturday only if a selected meeting falls on it; never
  Sunday), y-axis = time from `floor(min start time, to hour)` (clamped to no
  later than 8am) to `ceil(max end time, to hour)` (clamped to no earlier
  than 6pm), draw header row (day names) + time gutter (hour gridlines using
  `--gridline`-equivalent hex, since this is canvas not CSS — hardcode the
  hex `#e1e0d9` for gridlines / `#0b0b0b` for ink, this doesn't need to be
  theme-reactive per the "PNG should look right standalone" reasoning above),
  then draw each meeting as a rounded rect in its assigned color with Code,
  Section, Room, and Teacher name as wrapped text sized to fit the block
  (labs get more room since they're visually taller). Handle same-day
  overlaps by splitting column width evenly among the overlapping set (like a
  calendar app), not just letting them stack on top of each other.

## How to test while building

No build step. Serve statically and open in a browser, e.g. from the repo
root:
```
python -m http.server 8000
```
then visit `http://localhost:8000/`. The "Try the sample EE timetable" button
depends on being served over http(s) (not opened as a `file://` URL) because
it uses `fetch()` — mention this in the UI status text if a fetch fails.

Test against `EE Time Table (Fall 2026) v1.0.xlsx` — 46 unique course codes,
211 data rows, days Mon–Fri only in this particular file, times like
`8:30am`/`10:00am`/`11:30am`/`1:00pm`/`2:30pm`/`4:00pm`/`5:00pm` (main
80-min-period grid) plus some odd ones (`8:00am`, `9:00am`, `9:30am`,
`10:30am`, `12:00pm`, `1:30pm`, `3:00pm`) that don't fit the main grid
exactly — these are fine, they're just other scheduling patterns (electives,
grad courses); the theory/lab duration heuristic still applies to them.

## Not yet done / explicitly out of scope for v1

- Per-block manual duration editing (only the two global `#theory-min` /
  `#lab-min` overrides exist — deliberate scope cut, see reasoning above).
- Parsing the grid sheet's cell colors for exact per-class duration —
  decided against, too fragile across arbitrary uploaded files and SheetJS
  free-tier style support is unreliable.
- Any backend/server — don't add one.
- README.md hasn't been updated yet with run instructions; do that once
  app.js works (currently it's just the 3-line description that was already
  there).
