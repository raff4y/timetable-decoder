// Debounced, serialized autosave for the saved schedule.
//
//   const saver = createSaver({ send: (job) => Promise<boolean>, onStatus, delay: 800 });
//   saver.schedule({ timetableId, body });   // call on every change; latest wins
//   saver.flush();                           // send now (e.g. before switching timetable)
//   saver.retry();                           // re-send after a failure
//
// Statuses reported through onStatus: 'saving' | 'saved' | 'failed'.
// Only one request is in flight at a time, so writes for the same timetable can
// never arrive out of order.

export function createSaver({ send, onStatus = () => {}, delay = 800, timers = globalThis }) {
  let pending = null; // newest job not yet sent
  let failedJob = null; // last job that failed and has not been superseded
  let timer = null;
  let running = null;

  function clearTimer() {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  }

  function drain() {
    if (running) return running;
    running = (async () => {
      let status = null;
      // A newer change that is still inside its debounce window waits for its timer.
      while (pending && timer === null) {
        const job = pending;
        pending = null;
        let ok = false;
        try {
          ok = Boolean(await send(job));
        } catch {
          ok = false;
        }
        if (ok) {
          failedJob = null;
          status = 'saved';
        } else {
          failedJob = pending ? null : job; // a newer job supersedes the failed one
          status = 'failed';
        }
      }
      if (status && !pending) onStatus(status);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    schedule(job) {
      pending = job;
      failedJob = null;
      onStatus('saving');
      clearTimer();
      timer = timers.setTimeout(() => {
        timer = null;
        drain();
      }, delay);
    },

    flush() {
      clearTimer();
      return pending || running ? drain() : Promise.resolve();
    },

    retry() {
      if (!failedJob) return Promise.resolve();
      pending = failedJob;
      failedJob = null;
      onStatus('saving');
      clearTimer();
      return drain();
    },

    /** Drop anything queued (e.g. when saving must be disabled). */
    cancel() {
      clearTimer();
      pending = null;
      failedJob = null;
    },

    get hasPending() {
      return pending !== null || running !== null;
    },
  };
}
