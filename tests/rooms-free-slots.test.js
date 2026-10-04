// Free-slot export: gap maths and the text / CSV output.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FREE_SLOT_CUTOFF, buildFreeSlots, daysForScope, formatText, freeSlotsForDay, teachingWindow,
} from '../src/rooms/free-slots.js';

const h = (hours, mins = 0) => hours * 60 + mins;
const book = (dayIdx, start, end, extra = {}) => ({ dayIdx, startMin: start, endMin: end, ...extra });

describe('freeSlotsForDay', () => {
  test('returns the gaps between classes and the open ends of the window', () => {
    const bookings = [book(0, h(9), h(10, 30)), book(0, h(13), h(14))];
    const slots = freeSlotsForDay(bookings, 0, h(8), h(16));
    assert.deepEqual(slots.map((s) => [s.startMin, s.endMin]), [
      [h(8), h(9)], [h(10, 30), h(13)], [h(14), h(16)],
    ]);
  });

  test('an empty day is one slot spanning the whole window', () => {
    assert.deepEqual(freeSlotsForDay([book(1, h(9), h(10))], 0, h(8), h(18)),
      [{ startMin: h(8), endMin: h(18), minutes: 600 }]);
  });

  test('back-to-back and overlapping classes leave no gap between them', () => {
    const bookings = [book(0, h(9), h(10)), book(0, h(10), h(11)), book(0, h(10, 30), h(12))];
    const slots = freeSlotsForDay(bookings, 0, h(8), h(14));
    assert.deepEqual(slots.map((s) => [s.startMin, s.endMin]), [[h(8), h(9)], [h(12), h(14)]]);
  });

  test('classes are clipped to the window', () => {
    const bookings = [book(0, h(7), h(9)), book(0, h(17), h(19))];
    const slots = freeSlotsForDay(bookings, 0, h(8), h(18));
    assert.deepEqual(slots.map((s) => [s.startMin, s.endMin]), [[h(9), h(17)]]);
  });

  test('drops gaps shorter than the minimum, keeps ones exactly that long', () => {
    const bookings = [book(0, h(9), h(10)), book(0, h(10, 20), h(12)), book(0, h(12, 30), h(14))];
    const slots = freeSlotsForDay(bookings, 0, h(9), h(14), 30);
    assert.deepEqual(slots.map((s) => [s.startMin, s.endMin]), [[h(12), h(12, 30)]]);
  });

  test('a fully booked window has no slots', () => {
    assert.deepEqual(freeSlotsForDay([book(0, h(8), h(18))], 0, h(9), h(17)), []);
  });
});

describe('daysForScope', () => {
  test('a specific day, the whole week, or a set (sorted, de-duplicated, in range)', () => {
    assert.deepEqual(daysForScope('day', { day: 3 }), [3]);
    assert.deepEqual(daysForScope('week'), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(daysForScope('days', { days: [4, 0, 4, 2, 9] }), [0, 2, 4]);
    assert.deepEqual(daysForScope('days', { days: [] }), []);
  });
});

describe('buildFreeSlots / teachingWindow', () => {
  test('flags estimated lengths only when they touch the chosen days and window', () => {
    const bookings = [book(0, h(9), h(10), { estimated: true }), book(2, h(9), h(10))];
    assert.equal(buildFreeSlots(bookings, { days: [0], from: h(8), to: h(18) }).estimated, true);
    assert.equal(buildFreeSlots(bookings, { days: [2], from: h(8), to: h(18) }).estimated, false);
    assert.equal(buildFreeSlots(bookings, { days: [0], from: h(11), to: h(18) }).estimated, false);
  });

  test('no free slot runs past 5:30pm, whatever window is asked for', () => {
    const r = buildFreeSlots([book(0, h(9), h(10))], { days: [0, 1], from: h(8), to: h(22) });
    assert.equal(FREE_SLOT_CUTOFF, h(17, 30));
    assert.equal(r.to, h(17, 30));
    assert.deepEqual(r.days[0].slots.map((s) => [s.startMin, s.endMin]), [[h(8), h(9)], [h(10), h(17, 30)]]);
    assert.deepEqual(r.days[1].slots.map((s) => [s.startMin, s.endMin]), [[h(8), h(17, 30)]]);
    // a class that ends after the cutoff leaves nothing free after it
    const late = buildFreeSlots([book(0, h(16), h(19))], { days: [0], from: h(8), to: h(22) });
    assert.deepEqual(late.days[0].slots.map((s) => [s.startMin, s.endMin]), [[h(8), h(16)]]);
    // and a late class never stretches the default window past it
    assert.equal(teachingWindow([{ bookings: [book(0, h(16), h(19))] }], h(7), h(22)).to, h(17, 30));
  });

  test('teaching window rounds out to whole hours and clamps', () => {
    const rooms = [{ bookings: [book(0, h(8, 30), h(10))] }, { bookings: [book(1, h(15), h(17, 20))] }];
    assert.deepEqual(teachingWindow(rooms, h(7), h(22)), { from: h(8), to: h(17, 30) });
    assert.deepEqual(teachingWindow(rooms, h(9), h(17)), { from: h(9), to: h(17) });
    assert.deepEqual(teachingWindow([], h(7), h(22)), { from: h(7), to: h(22) });
  });
});

describe('text output', () => {
  const bookings = [book(0, h(9), h(10, 30)), book(2, h(8), h(18))];
  const opts = { days: [0, 1, 2], from: h(8), to: h(17, 30), minGap: 30 };
  const result = buildFreeSlots(bookings, opts);
  const meta = { roomLabel: 'D-6', where: 'D Block · Ground floor', result, from: h(8), to: h(17, 30), minGap: 30 };

  test('lists slots, all-day rooms and fully booked days', () => {
    const text = formatText(meta);
    assert.match(text, /^Free time slots - D-6 \(D Block · Ground floor\)\n8:00am - 5:30pm, gaps of 30 min or more\n/);
    assert.match(text, /Monday\n {2}8:00am - 9:00am \(1 hr\)\n {2}10:30am - 5:30pm \(7 hr\)\n/);
    assert.match(text, /Tuesday\n {2}Free all day \(8:00am - 5:30pm\)\n/);
    assert.match(text, /Wednesday\n {2}No free slots\n/);
    assert.doesNotMatch(text, /estimated/);
  });
});
