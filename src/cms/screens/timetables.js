// Timetables: upload a department export, then publish / edit / delete.
// Reads GET /api/admin/timetables (with usage counts); writes go through
// POST /api/timetables (raw xlsx bytes), PUT /api/timetables/:id (replace an
// existing timetable's file in place) and PATCH/DELETE /api/timetables/:id.
// #/timetables?replace=<id> opens with that timetable picked as the upload target.

import {
  api, badge, busy, button, card, clear, confirmDialog, emptyState, errorState, field, h, icon, input, openDialog,
  pageHead, select, skeleton, table, titleCell, toast,
} from '../ui.js';
import { formatBytes, formatDate, formatDateTime, formatNumber, plural } from '../format.js';

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // api/timetables/_lib.js

const NEW = 'new';
const nameOf = (t) => t.title || t.fileName || 'Untitled';

export async function render(ctx) {
  const state = { timetables: [], target: ctx.route.query.get('replace') || NEW };
  const fileInput = h('input', { type: 'file', accept: '.xlsx,.xls', class: 'visually-hidden', id: 'tt-file' });
  const status = h('div', { class: 'upload-status', role: 'status', 'aria-live': 'polite' });
  const warnings = h('div');
  const dropTitle = h('strong');
  const dropSub = h('span');
  const drop = h(
    'label',
    { class: 'dropzone', for: 'tt-file' },
    fileInput,
    h('span', { class: 'icon-tile' }, icon('upload', 22)),
    dropTitle,
    dropSub,
  );
  const targetHost = h('div', { class: 'upload-target' });
  const uploadCard = card({ title: 'Upload', className: 'upload-card', body: [targetHost, drop, status, warnings] });
  const listHost = h('div');

  ctx.view.append(
    pageHead({
      eyebrow: 'Manage',
      title: 'Timetables',
      description: 'Upload each department’s official Excel export, or a new version over an existing one. It’s parsed on the server; new timetables stay a draft until you publish them to students.',
    }),
    uploadCard,
    listHost,
  );
  listHost.append(skeleton(280));

  const targetTimetable = () => state.timetables.find((t) => t.id === state.target) || null;
  drawTarget();

  /** The "Upload As" picker: a new timetable, or which existing one to overwrite. */
  function drawTarget() {
    const target = targetTimetable();
    // Before the list loads, a ?replace=<id> target is kept so it can be honoured.
    if (!target && state.timetables.length) state.target = NEW;
    const options = [[NEW, 'New Timetable'], ...state.timetables.map((t) => [t.id, `Replace: ${nameOf(t)} (${t.isPublished ? 'Published' : 'Draft'})`])];
    const picker = select(options, target ? target.id : NEW);
    picker.addEventListener('change', () => {
      state.target = picker.value;
      clear(status);
      clear(warnings);
      drawTarget();
    });
    const hint = target
      ? `Overwrites “${nameOf(target)}” (now ${target.fileName || 'unnamed file'}, ${plural(target.sectionCount, 'section')}). Its title, department, semester and ${target.isPublished ? 'published' : 'draft'} status stay the same${target.schedules ? `, and ${plural(target.schedules, 'saved student schedule')} stay attached` : ''}.`
      : 'Adds a new timetable, saved as a draft until you publish it.';
    clear(targetHost, field('Upload As', picker, hint));
    drop.classList.toggle('dropzone--replace', Boolean(target));
    dropTitle.textContent = target ? `Drop The New Version Of “${nameOf(target)}” Here, Or Click To Choose` : 'Drop A Timetable Export Here, Or Click To Choose';
    dropSub.textContent = target
      ? '.xlsx up to 4 MB · replaces the current file and all its sections'
      : '.xlsx up to 4 MB · flat “List of Courses” or rooms-by-periods grid · saved as a draft';
  }

  /** Row action: pick this timetable as the target and open the file chooser. */
  function startReplace(t) {
    state.target = t.id;
    clear(status);
    clear(warnings);
    drawTarget();
    uploadCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    fileInput.click();
  }

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) upload(fileInput.files[0]);
    fileInput.value = '';
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('drag');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    const file = e.dataTransfer.files[0];
    if (file) upload(file);
  });

  async function upload(file) {
    clear(warnings);
    status.className = 'upload-status';
    const problem = fileProblem(file);
    if (problem) {
      status.className = 'upload-status err';
      status.textContent = problem;
      return;
    }
    const target = targetTimetable();
    if (target && !(await confirmReplace(target, file))) return;
    status.textContent = target ? `Uploading and parsing ${file.name} to replace “${nameOf(target)}”…` : `Uploading and parsing ${file.name}…`;
    drop.classList.add('is-refreshing');
    const res = target
      ? await putFile(target, file)
      : await api('/timetables', {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      });
    drop.classList.remove('is-refreshing');
    if (!ctx.isCurrent()) return;
    if (!res.ok) {
      status.className = 'upload-status err';
      const existing = res.data?.details?.existingId;
      clear(
        status,
        res.error.message,
        existing ? [' · ', h('a', { href: `#/timetables/${existing}` }, `Open “${res.data.details.existingTitle || 'the existing copy'}”`)] : null,
      );
      return;
    }
    const t = res.data.timetable;
    status.className = 'upload-status ok';
    if (target) {
      clear(status, replacedSummary(res.data, file), ' ', h('a', { href: `#/timetables/${t.id}` }, 'Review It'), '.');
      state.target = NEW; // so a second drop can't overwrite it again by accident
      drawTarget();
    } else {
      clear(status, `Uploaded “${t.title || file.name}”: ${plural(t.sectionCount, 'section')} found. It’s a draft. `, h('a', { href: `#/timetables/${t.id}` }, 'Review It'), ' before publishing.');
    }
    if (res.data.warnings?.length) {
      warnings.append(
        h(
          'div',
          { class: 'callout callout--warn', style: 'margin-top:12px' },
          h(
            'div',
            null,
            h('strong', null, `${plural(res.data.warnings.length, 'Note', 'Notes')} From The Parser`),
            h('ul', null, res.data.warnings.slice(0, 8).map((w) => h('li', null, w))),
            res.data.warnings.length > 8 ? h('span', null, `…and ${res.data.warnings.length - 8} more on the timetable’s page.`) : null,
          ),
        ),
      );
    }
    toast(target ? 'Timetable file replaced' : 'Timetable uploaded');
    load();
  }

  async function load() {
    const res = await api('/admin/timetables');
    if (!ctx.isCurrent()) return;
    if (!res.ok) {
      clear(listHost, errorState(res.error.message, load));
      return;
    }
    state.timetables = res.data.timetables;
    drawTarget();
    draw();
  }

  function draw() {
    const list = state.timetables;
    if (!list.length) {
      clear(listHost, card({ body: emptyState({ icon: 'calendar', title: 'No Timetables Yet', text: 'Uploaded timetables will be listed here.' }) }));
      return;
    }
    const published = list.filter((t) => t.isPublished).length;
    clear(
      listHost,
      card({
        title: 'Library',
        description: `${plural(list.length, 'timetable')} · ${formatNumber(published)} published`,
        flush: true,
        body: table(
          [
            { label: 'Timetable', main: true },
            { label: 'Status' },
            { label: 'Format' },
            { label: 'Sections', className: 'num' },
            { label: 'Saved', className: 'num' },
            { label: 'Uploaded' },
            { label: 'Actions', className: 'actions' },
          ],
          list.map((t) => [
            titleCell(t.title || t.fileName || 'Untitled', [t.department, t.semester].filter(Boolean).join(' · ') || t.fileName, `#/timetables/${t.id}`),
            h('div', { class: 'row-actions' }, badge(t.isPublished ? 'Published' : 'Draft', t.isPublished ? 'ok' : 'off'), t.warningCount ? badge(plural(t.warningCount, 'note'), 'warn', { plain: true }) : null),
            h('span', { class: 'muted nowrap' }, t.template === 'grid' ? 'Period Grid' : 'Flat List'),
            formatNumber(t.sectionCount),
            formatNumber(t.schedules),
            h('span', { class: 'nowrap', title: formatDateTime(t.uploadedAt) }, formatDate(t.uploadedAt), t.uploader ? h('span', { class: 'muted' }, ` · ${t.uploader.displayName || t.uploader.email}`) : null),
            actions(t),
          ]),
          { caption: 'Timetables' },
        ),
      }),
    );
  }

  function actions(t) {
    const toggle = button(t.isPublished ? 'Unpublish' : 'Publish', { variant: t.isPublished ? 'light' : 'ok', size: 'xs', icon: t.isPublished ? 'eyeOff' : 'eye' });
    toggle.addEventListener('click', () => togglePublish(toggle, t));
    return h(
      'div',
      { class: 'row-actions' },
      toggle,
      button('Replace File', { icon: 'upload', size: 'xs', onClick: () => startReplace(t) }),
      button('Edit', { icon: 'pencil', size: 'xs', onClick: () => editTimetable(t, ctx, (u) => replace(u)) }),
      button('Delete', { icon: 'trash', size: 'xs', variant: 'danger', onClick: () => deleteTimetable(t, () => remove(t.id)) }),
    );
  }

  function replace(updated) {
    state.timetables = state.timetables.map((x) => (x.id === updated.id ? { ...x, ...updated } : x));
    drawTarget();
    draw();
  }

  function remove(id) {
    state.timetables = state.timetables.filter((x) => x.id !== id);
    drawTarget();
    draw();
  }

  async function togglePublish(btn, t) {
    const next = !t.isPublished;
    const res = await busy(btn, () => api(`/timetables/${t.id}`, { method: 'PATCH', body: { isPublished: next } }));
    if (!res.ok) {
      toast(res.error.message, 'bad');
      return;
    }
    toast(next ? `Published “${t.title}”; students can see it now` : `Unpublished “${t.title}”`);
    replace(res.data.timetable);
  }

  await load();
}

/** Why a picked file can't be uploaded, or null. */
export function fileProblem(file) {
  if (!/\.xlsx?$/i.test(file.name)) return 'Choose an Excel file (.xlsx or .xls).';
  if (file.size > MAX_UPLOAD_BYTES) return `That file is ${formatBytes(file.size)}; the limit is 4 MB.`;
  return null;
}

/** Spell out what a replace keeps and changes; resolves true to go ahead. Shared with the detail screen. */
export function confirmReplace(t, file) {
  const schedules = t.schedules
    ? `, and ${plural(t.schedules, 'saved student schedule')} stay attached (any picked section the new file no longer has is dropped from them)`
    : '';
  return confirmDialog({
    title: 'Replace This Timetable’s File?',
    message: `“${nameOf(t)}” will take all its sections from ${file.name} instead of ${t.fileName || 'the current file'}. Its title, department, semester and ${t.isPublished ? 'published' : 'draft'} status stay the same${schedules}.${t.isPublished ? ' Students see the new version straight away.' : ''}`,
    confirmLabel: 'Replace File',
    danger: true,
  });
}

/** PUT the new file over timetable `t`. Shared with the detail screen. */
export function putFile(t, file) {
  return api(`/timetables/${t.id}`, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
  });
}

/** One-line result of a replace, from the PUT response. */
export function replacedSummary(data, file) {
  const t = data.timetable;
  const was = data.previousSectionCount;
  const sections = was === t.sectionCount ? plural(t.sectionCount, 'section') : `${formatNumber(was)} → ${plural(t.sectionCount, 'section')}`;
  const affected = data.affectedSchedules
    ? ` ${plural(data.affectedSchedules, 'saved schedule')} had picks that are gone now; those picks are dropped.`
    : '';
  return `Replaced the file of “${nameOf(t)}” with ${file.name}: ${sections}.${affected}`;
}

/** Edit title / department / semester. Shared with the detail screen. */
export async function editTimetable(t, ctx, onSaved) {
  const title = input({ type: 'text', value: t.title || '', maxlength: '200', required: true });
  const department = input({ type: 'text', value: t.department || '', maxlength: '200' });
  const semester = input({ type: 'text', value: t.semester || '', maxlength: '200', placeholder: 'Fall 2026' });
  const saved = await openDialog({
    title: 'Edit Timetable',
    description: 'Students see the title, department and semester when they pick a timetable.',
    fields: [field('Title', title), field('Department', department), field('Semester', semester)],
    onSubmit: async () => {
      if (!title.value.trim()) return 'The title can’t be empty.';
      const body = {};
      if (title.value.trim() !== t.title) body.title = title.value;
      if (department.value.trim() !== t.department) body.department = department.value;
      if (semester.value.trim() !== t.semester) body.semester = semester.value;
      if (!Object.keys(body).length) return true;
      const res = await api(`/timetables/${t.id}`, { method: 'PATCH', body });
      if (!res.ok) return res.error.message;
      return res.data.timetable;
    },
  });
  if (saved && saved !== true) {
    toast('Timetable saved');
    onSaved(saved);
  }
}

/** Confirm, then DELETE. Shared with the detail screen. */
export async function deleteTimetable(t, onDeleted) {
  const done = await openDialog({
    title: 'Delete This Timetable?',
    description: `“${t.title || t.fileName}” and its sections are removed for good${t.schedules ? `, along with ${plural(t.schedules, 'saved student schedule')}` : ''}. This can’t be undone.`,
    submitLabel: 'Delete Timetable',
    danger: true,
    onSubmit: async () => {
      const res = await api(`/timetables/${t.id}`, { method: 'DELETE' });
      return res.ok ? true : res.error.message;
    },
  });
  if (done) {
    toast('Timetable deleted');
    onDeleted();
  }
}
