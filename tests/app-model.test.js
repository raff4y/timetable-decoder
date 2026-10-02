import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ColorBook,
  PALETTE,
  sectionKey,
  baseNameKey,
  adaptSections,
  allDurationsExplicit,
  meetingIsLab,
  meetingDuration,
  serializeSchedule,
  restoreSchedule,
  groupTimetables,
  timetableOptionLabel,
  selectedEvents,
  findConflicts,
  resolveQuickAddToken,
  courseGroups,
  pickExamples,
  reviewSearchName,
  hasReviewLink,
  reviewUrl,
  sectionMeetingSummary,
  fmtMinutes,
  sectionParts,
} from '../src/app/model.js';

const API_SECTIONS = [
  {
    code: 'CS1001', name: 'Programming Fundamentals', section: 'BCS-1A', teacher: 'Dr Ali', batch: '2026', nameIsLab: false,
    meetings: [
      { dayIdx: 2, startMin: 600, rawTime: '10:00am', room: 'C-1', durMin: null, isLab: false },
      { dayIdx: 0, startMin: 540, rawTime: '9:00am', room: 'C-1', durMin: null, isLab: false },
    ],
  },
  {
    code: 'CL1001', name: 'Programming Fundamentals Lab', section: 'BCS-1A', teacher: '', batch: '', nameIsLab: true,
    meetings: [{ dayIdx: 1, startMin: 540, rawTime: '9:00am', room: 'Lab-3', durMin: 150, isLab: true }],
  },
  { code: 'MT1003', name: 'Calculus', section: 'BCS-1B', teacher: 'Ms Sara', batch: '', nameIsLab: false, meetings: [] },
];

test('adaptSections keeps the server shape, sorts meetings and uses the server isLab', () => {
  const out = adaptSections(API_SECTIONS);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].meetings.map((m) => m.dayIdx), [0, 2]);
  assert.equal(out[0].meetings[0].durMin, null);
  assert.equal(out[1].meetings[0].durMin, 150);
  assert.equal(out[1].meetings[0].isLab, true);
});

test('adaptSections drops malformed sections/meetings and fills defaults', () => {
  const out = adaptSections([
    null,
    { code: '', section: 'X' },
    { code: 'A1', section: 'S', meetings: [{ dayIdx: 9, startMin: 1 }, { dayIdx: 1, startMin: 'x' }, { dayIdx: 1, startMin: 60, durMin: 0 }] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, '');
  assert.equal(out[0].teacher, '');
  assert.equal(out[0].meetings.length, 1);
  assert.equal(out[0].meetings[0].durMin, null);
  assert.equal(out[0].meetings[0].room, '');
  assert.deepEqual(adaptSections(undefined), []);
});

test('durations: explicit durMin wins, null falls back to the theory/lab inputs', () => {
  const [theory, lab] = adaptSections(API_SECTIONS);
  assert.equal(meetingDuration(theory, theory.meetings[0], { theoryMin: 80, labMin: 150 }), 80);
  assert.equal(meetingDuration(theory, theory.meetings[0], { theoryMin: 90, labMin: 150 }), 90);
  assert.equal(meetingDuration(lab, lab.meetings[0], { theoryMin: 80, labMin: 999 }), 150); // explicit
  const labNoDuration = { ...lab, meetings: [{ ...lab.meetings[0], durMin: null }] };
  assert.equal(meetingDuration(labNoDuration, labNoDuration.meetings[0], { theoryMin: 80, labMin: 120 }), 120);
  assert.equal(allDurationsExplicit([lab]), true);
  assert.equal(allDurationsExplicit([theory, lab]), false);
});

test('meetingIsLab uses the stored flag, falling back to name/room', () => {
  assert.equal(meetingIsLab({ nameIsLab: false }, { room: 'x', isLab: true }), true);
  assert.equal(meetingIsLab({ nameIsLab: true }, { room: 'x' }), true);
  assert.equal(meetingIsLab({ nameIsLab: false }, { room: 'Computer Lab 2' }), true);
  assert.equal(meetingIsLab({ nameIsLab: false }, { room: 'C-1' }), false);
});

test('baseNameKey ties a lab to its theory course', () => {
  const k = baseNameKey('Programming Fundamentals');
  assert.equal(baseNameKey('Programming Fundamentals Lab'), k);
  assert.equal(baseNameKey('Programming Fundamentals - Lab'), k);
  assert.equal(baseNameKey('Programming Fundamentals (Lab)'), k);
});

test('ColorBook never recycles slots and shades colours once the palette runs out', () => {
  const book = new ColorBook();
  assert.equal(book.slotFor({ name: 'Physics' }), 0);
  assert.equal(book.slotFor({ name: 'Physics Lab' }), 0); // same course family
  assert.equal(book.slotFor({ name: 'Maths' }), 1);
  assert.equal(book.hexFor({ name: 'Physics' }), PALETTE[0]);
  for (let i = 0; i < PALETTE.length; i++) book.slotFor({ name: 'Course ' + i });
  // slot PALETTE.length + 1 reuses PALETTE[1]'s hue but must look different
  const wrapped = book.hexFor({ name: 'Course ' + (PALETTE.length - 1) });
  assert.match(wrapped, /^#[0-9a-f]{6}$/);
  assert.equal(book.slotFor({ name: 'Course ' + (PALETTE.length - 1) }), PALETTE.length + 1);
  assert.notEqual(wrapped, PALETTE[1]);
});

test('ColorBook round-trips through JSON and resumes after the highest saved slot', () => {
  const book = new ColorBook();
  book.slotFor({ name: 'A' });
  book.slotFor({ name: 'B' });
  const json = JSON.parse(JSON.stringify(book.toJSON()));
  assert.deepEqual(json, { a: 0, b: 1 });
  const restored = ColorBook.fromSaved({ ...json, junk: 'str', neg: -1, frac: 1.5 });
  assert.equal(restored.slots.size, 2);
  assert.equal(restored.slotFor({ name: 'C' }), 2);
  assert.equal(restored.slotFor({ name: 'A' }), 0);
  assert.equal(ColorBook.fromSaved(null).nextSlot, 0);
});

test('restoreSchedule restores saved sections in order and ignores keys that no longer exist', () => {
  const sections = adaptSections(API_SECTIONS);
  const saved = {
    sectionKeys: ['MT1003|BCS-1B', 'GONE|X', 'CS1001|BCS-1A'],
    colorAssignments: { calculus: 4, 'programming fundamentals': 2 },
  };
  const { selected, colors, dropped } = restoreSchedule(sections, saved);
  assert.deepEqual([...selected.keys()], ['MT1003|BCS-1B', 'CS1001|BCS-1A']);
  assert.equal(dropped, 1);
  assert.equal(colors.slotFor({ name: 'Calculus' }), 4);
  assert.equal(colors.slotFor({ name: 'Programming Fundamentals' }), 2);
  assert.equal(colors.slotFor({ name: 'Brand new course' }), 5); // continues after the saved max
});

test('restoreSchedule copes with no saved schedule', () => {
  const sections = adaptSections(API_SECTIONS);
  for (const saved of [null, undefined, {}, { sectionKeys: 'nope' }]) {
    const out = restoreSchedule(sections, saved);
    assert.equal(out.selected.size, 0);
    assert.equal(out.dropped, 0);
  }
});

test('serializeSchedule produces the PUT body and round-trips through restoreSchedule', () => {
  const sections = adaptSections(API_SECTIONS);
  const selected = new Map(sections.slice(0, 2).map((s) => [sectionKey(s), s]));
  const book = new ColorBook();
  selected.forEach((s) => book.slotFor(s));
  const body = serializeSchedule(selected, book);
  assert.deepEqual(body.sectionKeys, ['CS1001|BCS-1A', 'CL1001|BCS-1A']);
  assert.deepEqual(body.colorAssignments, { 'programming fundamentals': 0 });
  const back = restoreSchedule(sections, JSON.parse(JSON.stringify(body)));
  assert.deepEqual([...back.selected.keys()], body.sectionKeys);
});

test('serializeSchedule stays within the API limits', () => {
  const selected = new Map();
  for (let i = 0; i < 250; i++) selected.set('K' + i + '|S', { name: 'n' });
  selected.set('X'.repeat(130), { name: 'n' });
  const body = serializeSchedule(selected, new ColorBook());
  assert.ok(body.sectionKeys.length <= 200);
  assert.ok(body.sectionKeys.every((k) => k.length <= 120));
});

test('selectedEvents + findConflicts: overlapping classes conflict, a section never conflicts with itself', () => {
  const [a, lab, c] = adaptSections(API_SECTIONS);
  const defaults = { theoryMin: 80, labMin: 150 };
  const clash = { ...c, meetings: [{ dayIdx: 0, startMin: 570, rawTime: '9:30am', room: 'C-2', durMin: null }] };
  const events = selectedEvents(new Map([['a', a], ['c', clash], ['lab', lab]]), defaults);
  const conflicts = findConflicts(events);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].map((e) => e.sec.code).sort(), ['CS1001', 'MT1003']);
  const monday = events.find((e) => e.sec.code === 'CS1001' && e.dayIdx === 0);
  assert.equal(monday.end, 540 + 80);
});

test('resolveQuickAddToken resolves CODE-SECTION tokens', () => {
  const sections = adaptSections(API_SECTIONS);
  assert.equal(resolveQuickAddToken(sections, 'MT1003').section.section, 'BCS-1B'); // only section
  assert.equal(resolveQuickAddToken(sections, 'cs1001-1a').section.code, 'CS1001');
  assert.equal(resolveQuickAddToken(sections, 'XX9999').ok, false);
  assert.equal(resolveQuickAddToken(sections, 'hello').ok, false);
  assert.match(resolveQuickAddToken(sections, 'CS1001-ZZ').reason, /no section/);
});

test('courseGroups filters by code, name and section tokens', () => {
  const sections = adaptSections(API_SECTIONS);
  assert.equal(courseGroups(sections, '').length, 3);
  assert.equal(courseGroups(sections, 'lab').length, 1);
  assert.equal(courseGroups(sections, 'prog 1a').length, 2);
  assert.equal(courseGroups(sections, 'zzz').length, 0);
});

test('groupTimetables groups by department (A-Z, Other last) and newest upload first', () => {
  const groups = groupTimetables([
    { id: '1', department: 'EE', semester: 'Fall 2026', uploadedAt: '2026-08-01T00:00:00Z' },
    { id: '2', department: 'CS', semester: 'Spring 2026', uploadedAt: '2026-01-01T00:00:00Z' },
    { id: '3', department: '', semester: 'Fall 2026', uploadedAt: '2026-08-02T00:00:00Z' },
    { id: '4', department: 'CS', semester: 'Fall 2026', uploadedAt: '2026-08-05T00:00:00Z' },
  ]);
  assert.deepEqual(groups.map((g) => g.department), ['CS', 'EE', 'Other']);
  assert.deepEqual(groups[0].items.map((t) => t.id), ['4', '2']);
});

test('timetableOptionLabel', () => {
  assert.equal(timetableOptionLabel({ semester: 'Fall 2026', sectionCount: 120, isPublished: true }), 'Fall 2026 · 120 sections');
  assert.equal(timetableOptionLabel({ semester: '', title: 'My TT', sectionCount: 1, isPublished: false }, { showDraft: true }), 'My TT · 1 section · unpublished');
  assert.equal(timetableOptionLabel({ semester: 'Fall 2026', sectionCount: 2, isPublished: false }), 'Fall 2026 · 2 sections');
});

test('pickExamples, review links and summaries', () => {
  const sections = adaptSections(API_SECTIONS);
  const ex = pickExamples(sections);
  assert.equal(ex.codeSection, 'CS1001-BCS-1A');
  assert.equal(ex.codeSection2, 'CL1001-BCS-1A');
  assert.equal(ex.nameWord, 'Fundamentals');

  assert.equal(reviewSearchName('Dr. Muhammad Ali (Visiting)'), 'Muhammad Ali');
  assert.equal(hasReviewLink('TBA'), false);
  assert.equal(hasReviewLink('Lab Engineer'), false);
  assert.equal(hasReviewLink('Dr Ali Khan'), true);
  assert.equal(reviewUrl('Dr Ali Khan', 'Lahore'), 'https://nucesrate.vercel.app/professors?pg=1&prof=Ali%20Khan&campus=Lahore');
  assert.equal(reviewUrl('Dr Ali Khan', ''), 'https://nucesrate.vercel.app/professors?pg=1&prof=Ali%20Khan');

  assert.equal(sectionMeetingSummary(sections[0]), 'Mon 9:00am, Wed 10:00am · C-1');
  assert.equal(fmtMinutes(13 * 60 + 5), '1:05pm');
  assert.deepEqual(sectionParts('BCS-3A1'), { base: 'BCS-3A', sub: '1' });
});
