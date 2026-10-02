// Synthetic workbooks built in code (no real department files are committed).
import * as XLSX from 'xlsx';

function toBuffer(wb) {
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

/** Flat "List of Courses" template. */
export function flatWorkbook({ extraRows = [] } = {}) {
  const rows = [
    ['Time Table [Computer Science] Fall 2026'],
    [],
    ['Code', 'Course', 'Section', 'Teacher', 'Day', 'Time', 'Room', 'Batch'],
    ['CS1002', 'Programming Fundamentals', 'A', 'Dr. Ayesha Khan', 'Monday', '8:30 AM', 'C-101', '2026'],
    ['CS1002', 'Programming Fundamentals', 'A', 'Dr. Ayesha Khan', 'Wednesday', '8:30 AM', 'C-101', '2026'],
    ['CS1002', 'Programming Fundamentals', 'A', 'Dr. Ayesha Khan', 'Wednesday', '8:30 AM', 'C-101', '2026'], // duplicate
    ['CL1002', 'Programming Fundamentals Lab', 'A1', 'Mr. Bilal Ahmed', 'Tuesday', '11:30', 'Lab 2', '2026'],
    ['MT1003', 'Calculus', 'B', 'Ms. Sana Iqbal', 'Thu', '2:30 PM', 'C-205', ''],
    ['MT1003', 'Calculus', 'B', 'Ms. Sana Iqbal', 'Sat', '9:00 a.m.', 'C-205', ''],
    ['XX0000', 'Broken Row', 'A', 'Nobody', 'Someday', '9:00 AM', 'R1', ''], // unreadable day -> skipped
    ...extraRows,
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'List of Courses');
  return toBuffer(wb);
}

/**
 * Period-grid template: a rooms-by-periods grid (10 minute columns) plus a
 * course-list sheet. Row 0 title, row 1 period headers, row 2 "Days" row.
 */
export function gridWorkbook() {
  const PERIODS = [['08:30-10:00', 0], ['10:00-11:30', 9], ['11:30-13:00', 18]];
  const NCOLS = 2 + 27;
  const blank = () => new Array(NCOLS).fill('');

  const title = blank();
  title[0] = 'Time Table [School of Computing] Fall 2026';

  const periodRow = blank();
  PERIODS.forEach(([label, off]) => { periodRow[2 + off] = label; });

  const daysRow = blank();
  daysRow[0] = 'Days';
  daysRow[1] = 'Room';

  const r1 = blank();
  r1[0] = 'Monday';
  r1[1] = 'C-101';
  r1[2] = 'Data Structures (CS-A) Dr. Omar Farooq'; // merged over 9 columns below
  const r2 = blank();
  r2[1] = 'Lab-1';
  r2[2 + 9] = 'Data Structures Lab (CS-A1) Mr. Hamza'; // single cell: lasts the rest of the period
  const r3 = blank();
  r3[0] = 'Tuesday';
  r3[1] = 'C-102';
  r3[2 + 18] = 'Calculus (CS-B) 11:30 to 1:00 Ms. Sana Iqbal'; // typed time wins
  const r4 = blank();
  r4[1] = 'C-103';
  r4[2 + 18] = 'Islamiat (CS-A) & Ethics (CS-B) Ms. X'; // two courses in one cell

  const grid = XLSX.utils.aoa_to_sheet([title, periodRow, daysRow, r1, r2, r3, r4]);
  grid['!merges'] = [{ s: { r: 3, c: 2 }, e: { r: 3, c: 10 } }];

  const list = XLSX.utils.aoa_to_sheet([
    ['Code', 'Course Title', 'Section', 'Instructor', 'Offered To'],
    ['CS2001', 'Data Structures', 'CS-A', 'Dr. Omar Farooq', 'BCS-3'],
    ['CL2001', 'Data Structures Lab', 'CS-A1', 'Mr. Hamza', 'BCS-3'],
    ['MT1003', 'Calculus', 'CS-B', 'Ms. Sana Iqbal', 'BCS-1'],
  ]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, grid, 'Combined');
  XLSX.utils.book_append_sheet(wb, list, 'List of Courses');
  return toBuffer(wb);
}

/** A workbook that is neither template. */
export function unrelatedWorkbook() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name', 'Marks'], ['Ali', 90]]), 'Sheet1');
  return toBuffer(wb);
}
