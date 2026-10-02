import test from 'node:test';
import assert from 'node:assert/strict';
import { createSaver } from '../src/app/saver.js';

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn) {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fire() {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((fn) => fn());
    },
    get count() {
      return pending.size;
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test('debounces rapid changes into one request carrying the latest body', async () => {
  const timers = fakeTimers();
  const sent = [];
  const statuses = [];
  const saver = createSaver({ timers, onStatus: (s) => statuses.push(s), send: async (job) => { sent.push(job); return true; } });
  saver.schedule({ timetableId: 't1', body: { n: 1 } });
  saver.schedule({ timetableId: 't1', body: { n: 2 } });
  saver.schedule({ timetableId: 't1', body: { n: 3 } });
  assert.equal(timers.count, 1);
  assert.equal(sent.length, 0);
  timers.fire();
  await tick();
  assert.deepEqual(sent, [{ timetableId: 't1', body: { n: 3 } }]);
  assert.deepEqual(statuses, ['saving', 'saving', 'saving', 'saved']);
});

test('flush sends immediately and cancels the pending timer', async () => {
  const timers = fakeTimers();
  const sent = [];
  const saver = createSaver({ timers, send: async (job) => { sent.push(job); return true; } });
  saver.schedule({ timetableId: 'a', body: 1 });
  await saver.flush();
  assert.equal(sent.length, 1);
  assert.equal(timers.count, 0);
  await saver.flush(); // nothing pending: no extra request
  assert.equal(sent.length, 1);
});

test('only one request at a time; a change made mid-flight is sent afterwards, in order', async () => {
  const timers = fakeTimers();
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  let inFlight = 0;
  let maxInFlight = 0;
  const saver = createSaver({
    timers,
    send: async (job) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (job.body === 1) await gate;
      order.push(job.body);
      inFlight--;
      return true;
    },
  });
  saver.schedule({ timetableId: 'a', body: 1 });
  timers.fire();
  await tick();
  saver.schedule({ timetableId: 'a', body: 2 });
  timers.fire();
  await tick();
  release();
  await saver.flush();
  assert.deepEqual(order, [1, 2]);
  assert.equal(maxInFlight, 1);
});

test('failure reports failed, retry re-sends, and a newer change supersedes the failed one', async () => {
  const timers = fakeTimers();
  const statuses = [];
  const sent = [];
  let ok = false;
  const saver = createSaver({ timers, onStatus: (s) => statuses.push(s), send: async (job) => { sent.push(job.body); return ok; } });
  saver.schedule({ timetableId: 'a', body: 'x' });
  await saver.flush();
  assert.equal(statuses.at(-1), 'failed');
  ok = true;
  await saver.retry();
  assert.deepEqual(sent, ['x', 'x']);
  assert.equal(statuses.at(-1), 'saved');

  ok = false;
  saver.schedule({ timetableId: 'a', body: 'y' });
  await saver.flush();
  saver.schedule({ timetableId: 'a', body: 'z' }); // supersedes the failed 'y'
  await saver.retry(); // nothing has failed any more, so no resend
  assert.deepEqual(sent, ['x', 'x', 'y']);
});

test('a throwing send counts as a failure', async () => {
  const timers = fakeTimers();
  const statuses = [];
  const saver = createSaver({ timers, onStatus: (s) => statuses.push(s), send: async () => { throw new Error('boom'); } });
  saver.schedule({ timetableId: 'a', body: 1 });
  await saver.flush();
  assert.equal(statuses.at(-1), 'failed');
});

test('cancel drops queued work', async () => {
  const timers = fakeTimers();
  const sent = [];
  const saver = createSaver({ timers, send: async (job) => { sent.push(job); return true; } });
  saver.schedule({ timetableId: 'a', body: 1 });
  saver.cancel();
  assert.equal(timers.count, 0);
  await saver.flush();
  assert.equal(sent.length, 0);
});
