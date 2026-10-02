import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionLabel,
  actionTone,
  delta,
  formatBytes,
  formatNumber,
  initials,
  meetingLabel,
  minutesToTime,
  niceScale,
  percent,
  shortDay,
  timeAgo,
} from '../src/cms/format.js';

test('numbers, bytes and percentages', () => {
  assert.equal(formatNumber(1284), '1,284');
  assert.equal(formatNumber(12_900), '12.9K');
  assert.equal(formatNumber(2.46), '2.5');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(3.5 * 1024 * 1024), '3.5 MB');
  assert.equal(percent(1, 3), 33);
  assert.equal(percent(5, 0), 0);
});

test('times and days', () => {
  assert.equal(minutesToTime(510), '8:30am');
  assert.equal(minutesToTime(720), '12:00pm');
  assert.equal(minutesToTime(0), '12:00am');
  assert.equal(minutesToTime(14 * 60 + 30), '2:30pm');
  assert.equal(meetingLabel({ dayIdx: 0, startMin: 510, room: 'C-101' }), 'Mon 8:30am · C-101');
  assert.equal(meetingLabel({ dayIdx: 5, startMin: 540, room: '' }), 'Sat 9:00am');
  assert.equal(shortDay('2026-10-01'), '1 Oct');
  assert.equal(shortDay('nope'), 'nope');
});

test('timeAgo', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  assert.equal(timeAgo(null, now), 'Never');
  assert.equal(timeAgo('2026-10-01T11:59:30Z', now), 'Just now');
  assert.equal(timeAgo('2026-10-01T11:55:00Z', now), '5 min ago');
  assert.equal(timeAgo('2026-10-01T09:00:00Z', now), '3 h ago');
  assert.equal(timeAgo('2026-09-30T12:00:00Z', now), 'Yesterday');
  assert.equal(timeAgo('2026-09-27T12:00:00Z', now), '4 days ago');
});

test('delta, initials, labels', () => {
  assert.deepEqual(delta(5, 3), { text: '+2 vs last week', dir: 'up' });
  assert.deepEqual(delta(1, 4), { text: '−3 vs last week', dir: 'down' });
  assert.equal(delta(2, 2).dir, 'flat');
  assert.equal(initials('Ada Lovelace'), 'AL');
  assert.equal(initials('', 'sara.khan@fast.edu.pk'), 'SK');
  assert.equal(initials('', 'x@y.z'), 'X');
  assert.equal(actionLabel('user.approve'), 'Approved User');
  assert.equal(actionLabel('room.password_reset'), 'Room Password Reset');
  assert.equal(actionTone('timetable.delete'), 'bad');
  assert.equal(actionTone('timetable.publish'), 'ok');
  assert.equal(actionTone('user.role'), 'info');
});

test('niceScale gives clean integer ticks', () => {
  assert.deepEqual(niceScale(0), { max: 4, step: 1 });
  assert.deepEqual(niceScale(3), { max: 3, step: 1 });
  assert.deepEqual(niceScale(17), { max: 20, step: 5 });
  assert.deepEqual(niceScale(230), { max: 250, step: 50 });
});
