// Unit coverage for the server parser's forgiving behaviours (always runs; no real files needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkbook, TimetableParseError, meetingIsLab } from '../server/parser/index.js';
import { parseDay, parseTimeToMinutes, parsePeriodHeader, findTimeRange, fmtMinutes } from '../server/parser/time.js';
import { parseGridCellEntries } from '../server/parser/grid.js';
import { flatWorkbook, gridWorkbook, unrelatedWorkbook } from './fixtures/build-workbooks.js';

test('days and clock times in their many dialects', () => {
  assert.equal(parseDay('Monday'), 0);
  assert.equal(parseDay('thurs'), 3);
  assert.equal(parseDay('SUN'), 6);
  assert.equal(parseDay('funday'), null);
  assert.equal(parseTimeToMinutes('8:30 AM'), 510);
  assert.equal(parseTimeToMinutes('12:00 PM'), 720);
  assert.equal(parseTimeToMinutes('6:00 P.M.'), 1080);
  assert.equal(parseTimeToMinutes('11:30'), 690);
  assert.equal(parseTimeToMinutes('2:30'), 870); // bare 1-6 is afternoon
  assert.equal(parseTimeToMinutes('soon'), null);
  assert.equal(fmtMinutes(510), '8:30am');
  assert.equal(fmtMinutes(870), '2:30pm');
});

test('period headers and time ranges', () => {
  assert.deepEqual(
    (({ startMin, endMin }) => ({ startMin, endMin }))(parsePeriodHeader('08:30-10:00')),
    { startMin: 510, endMin: 600 }
  );
  assert.equal(parsePeriodHeader('8:30 AM to 9:50 AM').endMin, 590);
  assert.equal(parsePeriodHeader('6:00 P.M.to 9:00 PM').startMin, 1080);
  assert.equal(parsePeriodHeader('8:30–10:00').endMin, 600); // en dash
  assert.equal(parsePeriodHeader('Room 08:30-10:00'), null);
  assert.equal(findTimeRange('1:00 to 11:30'), null); // longer than 8 hours is rejected
});

test('grid cells: brackets, ampersand pairs, typed times, mistyped brackets', () => {
  const plain = parseGridCellEntries('Calculus (BCS-1A) Dr. Ali');
  assert.deepEqual(plain.map(({ title, section, teacher }) => ({ title, section, teacher })), [
    { title: 'Calculus', section: 'BCS-1A', teacher: 'Dr. Ali' },
  ]);

  const pair = parseGridCellEntries('Islamiat (BCS-1A) & Ethics (BCS-1B) Ms. X');
  assert.deepEqual(pair.map((e) => [e.title, e.section, e.teacher]), [
    ['Islamiat', 'BCS-1A', ''],
    ['Ethics', 'BCS-1B', 'Ms. X'],
  ]);

  const typed = parseGridCellEntries('Marketing: (MBA-1) 6:00 to 9:00 Ms. Y');
  assert.equal(typed[0].range.startMin, 1080);
  assert.equal(typed[0].range.endMin, 1260);
  assert.equal(typed[0].teacher, 'Ms. Y');

  const mistyped = parseGridCellEntries('Data Structures (CS-3A Dr. Omar');
  assert.equal(mistyped[0].section, 'CS-3A');
  assert.equal(mistyped[0].title, 'Data Structures');
});

test('flat template: durations are null and lab flags derive from name or room', () => {
  const { meta, sections } = parseWorkbook(flatWorkbook(), 'x.xlsx');
  assert.equal(meta.template, 'flat');
  assert.deepEqual(sections.map((s) => s.code), ['CL1002', 'CS1002', 'MT1003']);
  for (const s of sections) for (const m of s.meetings) assert.equal(m.durMin, null);
  const byCode = Object.fromEntries(sections.map((s) => [s.code, s]));
  assert.equal(meetingIsLab(byCode.CL1002, byCode.CL1002.meetings[0]), true);
  assert.equal(meetingIsLab(byCode.CS1002, byCode.CS1002.meetings[0]), false);
  assert.equal(meetingIsLab(byCode.CS1002, { room: 'Lab 3' }), true);
  // meetings sorted by day then time; rawTime kept as typed
  assert.deepEqual(byCode.MT1003.meetings.map((m) => [m.dayIdx, m.rawTime]), [[3, '2:30 PM'], [5, '9:00 a.m.']]);
});

test('grid template: durations from typed time, merged width, or the period', () => {
  const { meta, sections, warnings } = parseWorkbook(gridWorkbook(), 'g.xlsx');
  assert.equal(meta.template, 'grid');
  assert.equal(meta.department, 'School of Computing');
  const dur = (code) => sections.find((s) => s.code === code).meetings[0].durMin;
  assert.equal(dur('CS2001'), 90); // merged over 9 columns
  assert.equal(dur('CL2001'), 90); // rest of the period
  assert.equal(dur('MT1003'), 90); // typed 11:30 to 1:00
  // Courses missing from the course list keep their grid title as code and are reported.
  assert.ok(sections.some((s) => s.code === 'Ethics'));
  assert.ok(warnings.some((w) => /Ethics/.test(w)));
});

test('unrecognised or unreadable files raise TimetableParseError', () => {
  assert.throws(() => parseWorkbook(unrelatedWorkbook(), 'x.xlsx'), TimetableParseError);
  assert.throws(() => parseWorkbook(Buffer.from('plain text, not a workbook'), 'x.xlsx'), TimetableParseError);
});

test('semester comes from the title before the file name', () => {
  const { meta } = parseWorkbook(flatWorkbook(), 'Timetable Spring-2027.xlsx');
  assert.equal(meta.semester, 'Fall 2026'); // title wins over the file name
});
