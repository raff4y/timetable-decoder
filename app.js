// The timetable tool (app.html). Timetables are parsed and stored server-side;
// this page lets a signed-in student pick one, choose sections, see conflicts,
// and export a PNG. Chosen sections are saved to their account.
//
// Pure logic lives in src/app/model.js, drawing in src/app/canvas.js and the
// debounced autosave in src/app/saver.js.

import { requireUser, apiFetch, signOut } from './src/auth-client.js';
import {
  WEEKDAYS,
  DEFAULT_THEORY_MIN,
  DEFAULT_LAB_MIN,
  ColorBook,
  sectionKey,
  sectionMeetingSummary,
  adaptSections,
  allDurationsExplicit,
  serializeSchedule,
  restoreSchedule,
  groupTimetables,
  timetableOptionLabel,
  GENERIC_EXAMPLES,
  pickExamples,
  hasReviewLink,
  reviewSearchName,
  reviewUrl,
  courseGroups,
  resolveQuickAddToken,
  matchesFilter,
  teacherCatalog,
  teacherInitials,
  sectionCatalog,
  selectedEvents,
  findConflicts,
  fmtMinutes,
} from './src/app/model.js';
import { renderTimetable } from './src/app/canvas.js';
import { createSaver } from './src/app/saver.js';

const CAMPUSES = ['Islamabad', 'Karachi', 'Lahore', 'Peshawar', 'Chiniot-Faisalabad'];
const CAMPUS_STORAGE_KEY = 'td.reviewCampus';
const TIMETABLE_STORAGE_KEY = 'td.timetableId';
const SAVE_DELAY_MS = 800;

const $ = (id) => document.getElementById(id);
const page = $('page');
const userName = $('user-name');
const adminLink = $('admin-link');
const signOutBtn = $('signout-btn');
const timetableSelect = $('timetable-select');
const pickerStatus = $('picker-status');
const pickerRetry = $('picker-retry');
const pickerAdminLink = $('picker-admin-link');
const buildPanel = $('build-panel');
const imagePanel = $('image-panel');
const timetableSummary = $('timetable-summary');
const courseSearch = $('course-search');
const searchResults = $('search-results');
const quickAddInput = $('quick-add-input');
const quickAddExample = $('quick-add-example');
const quickAddResolve = $('quick-add-resolve');
const quickAddFeedback = $('quick-add-feedback');
const selectedList = $('selected-list');
const selectedCount = $('selected-count');
const emptySelectedHint = $('empty-selected-hint');
const saveStatus = $('save-status');
const saveRetry = $('save-retry');
const conflictBanner = $('conflict-banner');
const conflictText = $('conflict-text');
const theoryMinInput = $('theory-min');
const labMinInput = $('lab-min');
const canvas = $('timetable-canvas');
const downloadBtn = $('download-btn');
const browseModal = $('browse-modal');
const browseOpenBtn = $('browse-open');
const browseCloseBtn = $('browse-close');
const browseDoneBtn = $('browse-done');
const browseFootCount = $('browse-foot-count');
const browseStats = $('browse-stats');
const browseContent = $('browse-content');
const browseFilter = $('browse-filter');
const browseJump = $('browse-jump');
const browseJumpLabel = $('browse-jump-label');
const tabCourses = $('tab-courses');
const tabTeachers = $('tab-teachers');
const tabSections = $('tab-sections');
const campusSelect = $('campus-select');
const advancedHint = document.querySelector('.advanced-hint');
const defaultAdvancedHint = advancedHint.textContent;

const state = {
  user: null,
  timetables: [],
  timetableId: null,
  meta: null,
  examples: null,
  sections: [],
  selected: new Map(),
  colors: new ColorBook(),
  saveEnabled: false,
  browseView: 'courses',
  reviewCampus: '',
};

// ------------------------------------------------------------- small helpers

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice just isn't remembered */
  }
}

const savedCampus = storageGet(CAMPUS_STORAGE_KEY);
if (savedCampus && CAMPUSES.includes(savedCampus)) state.reviewCampus = savedCampus;

function colorFor(sec) {
  return state.colors.hexFor(sec);
}

function intInput(input, fallback) {
  const v = parseInt(input.value, 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function durationDefaults() {
  return {
    theoryMin: intInput(theoryMinInput, DEFAULT_THEORY_MIN),
    labMin: intInput(labMinInput, DEFAULT_LAB_MIN),
  };
}

function reviewLink(teacher, label) {
  if (!hasReviewLink(teacher)) return null;
  const a = el('a', 'prof-link');
  a.href = reviewUrl(teacher, state.reviewCampus);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.appendChild(el('span', 'prof-link-text', label || 'Reviews'));
  a.appendChild(el('span', 'prof-link-arrow', '↗'));
  a.setAttribute('aria-label', 'See student reviews for ' + reviewSearchName(teacher) + ' on NUCESRate (opens in a new tab)');
  a.title = a.getAttribute('aria-label');
  // Inside clickable rows: following the link must not also toggle the row.
  a.addEventListener('click', (ev) => ev.stopPropagation());
  return a;
}

// ------------------------------------------------------------------- header

function renderHeader(user) {
  userName.textContent = user.displayName || user.email;
  userName.title = user.email;
  adminLink.hidden = user.role !== 'admin';
}

signOutBtn.addEventListener('click', async () => {
  signOutBtn.disabled = true;
  await saver.flush();
  await signOut();
  location.replace('/login.html');
});

// ------------------------------------------------------- saved-schedule sync

const SAVE_LABELS = { saving: 'Saving…', saved: 'Saved', failed: 'Not saved', off: 'Not saving', idle: '' };

function setSaveStatus(kind) {
  saveStatus.dataset.state = kind;
  saveStatus.textContent = SAVE_LABELS[kind] || '';
  saveRetry.hidden = kind !== 'failed';
}

const saver = createSaver({
  delay: SAVE_DELAY_MS,
  onStatus: setSaveStatus,
  async send(job) {
    const res = await apiFetch('/schedules/' + encodeURIComponent(job.timetableId), { method: 'PUT', body: job.body });
    return res.ok;
  },
});

function queueSave() {
  if (!state.timetableId || !state.saveEnabled) return;
  saver.schedule({ timetableId: state.timetableId, body: serializeSchedule(state.selected, state.colors) });
}

saveRetry.addEventListener('click', () => { saver.retry(); });

// Don't lose a change made just before the tab is hidden or closed.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saver.flush();
});
window.addEventListener('pagehide', () => { saver.flush(); });

// ------------------------------------------------------------ timetable picker

function setPickerStatus(message, kind) {
  pickerStatus.textContent = message;
  pickerStatus.classList.toggle('error', kind === 'error');
  pickerStatus.classList.toggle('success', kind === 'success');
}

function setPickerRetry(handler) {
  pickerRetry.hidden = !handler;
  pickerRetry.onclick = handler || null;
}

function fillTimetableSelect() {
  timetableSelect.textContent = '';
  const isAdmin = state.user.role === 'admin';
  const placeholder = el('option', null, 'Choose a timetable…');
  placeholder.value = '';
  timetableSelect.appendChild(placeholder);
  groupTimetables(state.timetables).forEach((group) => {
    const og = document.createElement('optgroup');
    og.label = group.department;
    group.items.forEach((t) => {
      const opt = el('option', null, timetableOptionLabel(t, { showDraft: isAdmin }));
      opt.value = t.id;
      og.appendChild(opt);
    });
    timetableSelect.appendChild(og);
  });
}

async function loadTimetableList({ preselect, notice }) {
  timetableSelect.disabled = true;
  pickerAdminLink.hidden = true;
  setPickerRetry(null);
  setPickerStatus('Loading timetables…');

  const res = await apiFetch('/timetables');
  if (!res.ok) {
    setPickerStatus('Couldn’t load the timetable list. ' + res.error.message, 'error');
    setPickerRetry(() => loadTimetableList({ preselect: storageGet(TIMETABLE_STORAGE_KEY) }));
    return;
  }

  state.timetables = Array.isArray(res.data && res.data.timetables) ? res.data.timetables : [];
  fillTimetableSelect();

  if (!state.timetables.length) {
    const isAdmin = state.user.role === 'admin';
    setPickerStatus(isAdmin
      ? 'No timetables have been uploaded yet.'
      : 'No timetables have been published yet. Check back soon.');
    pickerAdminLink.hidden = !isAdmin;
    return;
  }

  timetableSelect.disabled = false;
  setPickerStatus('');
  const wanted = state.timetables.find((t) => t.id === preselect) || (state.timetables.length === 1 ? state.timetables[0] : null);
  if (wanted) {
    timetableSelect.value = wanted.id;
    await selectTimetable(wanted.id, { scroll: false });
  } else if (notice) {
    setPickerStatus(notice, 'error');
  }
}

let loadToken = 0;

function clearLoaded() {
  state.timetableId = null;
  state.meta = null;
  state.examples = null;
  state.sections = [];
  state.selected = new Map();
  state.colors = new ColorBook();
  state.saveEnabled = false;
  buildPanel.hidden = true;
  imagePanel.hidden = true;
  browseOpenBtn.disabled = true;
  browseOpenBtn.title = 'Choose a timetable first';
  setSaveStatus('idle');
}

async function selectTimetable(id, { scroll }) {
  const token = ++loadToken;
  setPickerRetry(null);
  // Finish saving the previous timetable's schedule before replacing it.
  await saver.flush();
  if (token !== loadToken) return;
  clearLoaded();

  if (!id) {
    setPickerStatus('');
    return;
  }
  storageSet(TIMETABLE_STORAGE_KEY, id);
  setPickerStatus('Loading timetable…');
  timetableSelect.disabled = true;

  const [ttRes, schedRes] = await Promise.all([
    apiFetch('/timetables/' + encodeURIComponent(id)),
    apiFetch('/schedules/' + encodeURIComponent(id)),
  ]);
  if (token !== loadToken) return;
  timetableSelect.disabled = false;

  if (!ttRes.ok) {
    if (ttRes.status === 404) {
      // Unpublished or deleted since the list was fetched.
      storageSet(TIMETABLE_STORAGE_KEY, null);
      await loadTimetableList({ preselect: null, notice: 'That timetable is no longer available.' });
      return;
    }
    setPickerStatus('Couldn’t load that timetable. ' + ttRes.error.message, 'error');
    setPickerRetry(() => selectTimetable(id, { scroll }));
    return;
  }

  const timetable = ttRes.data.timetable;
  const sections = adaptSections(ttRes.data.sections);
  if (!sections.length) {
    setPickerStatus('That timetable has no classes in it.', 'error');
    return;
  }

  const saved = schedRes.ok && schedRes.data ? schedRes.data.schedule : null;
  const restored = restoreSchedule(sections, saved);

  state.timetableId = timetable.id;
  state.meta = { department: timetable.department || '', semester: timetable.semester || '', title: timetable.title || '' };
  state.sections = sections;
  state.examples = pickExamples(sections);
  state.selected = restored.selected;
  state.colors = restored.colors;
  // If the saved schedule couldn't be read, saving now would overwrite it with an
  // empty one, so autosave stays off until the page is reloaded.
  state.saveEnabled = schedRes.ok;

  const courseCount = new Set(sections.map((s) => s.code)).size;
  const parts = [];
  if (state.meta.department) parts.push(state.meta.department);
  if (state.meta.semester) parts.push(state.meta.semester);
  parts.push(courseCount + ' courses · ' + sections.length + ' sections');
  timetableSummary.textContent = parts.join(' - ');

  const explicit = timetable.explicitDurations === undefined
    ? allDurationsExplicit(sections)
    : Boolean(timetable.explicitDurations);
  theoryMinInput.disabled = explicit;
  labMinInput.disabled = explicit;
  advancedHint.textContent = explicit
    ? 'This timetable lists the exact length of every class, so no estimates are needed - these inputs are disabled.'
    : defaultAdvancedHint;

  browseJumpLabel.textContent = '';
  browseJumpLabel.append('Not sure what’s on offer? ');
  browseJumpLabel.appendChild(el('strong', null, 'Browse all ' + courseCount + ' courses'));

  buildPanel.hidden = false;
  imagePanel.hidden = false;
  browseOpenBtn.disabled = false;
  browseOpenBtn.removeAttribute('title');

  if (schedRes.ok) {
    setPickerStatus(restored.selected.size
      ? 'Restored your saved schedule (' + restored.selected.size + (restored.selected.size === 1 ? ' section).' : ' sections).')
      : '', 'success');
    setSaveStatus('idle');
  } else {
    setPickerStatus('Couldn’t load your saved schedule, so changes won’t be saved on this page.', 'error');
    setPickerRetry(() => selectTimetable(id, { scroll }));
    setSaveStatus('off');
  }

  applyExamples();
  quickAddFeedback.textContent = '';
  courseSearch.value = '';
  browseFilter.value = '';
  renderSearchResults();
  renderBrowse();
  renderAll();
  if (scroll) buildPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

timetableSelect.addEventListener('change', () => {
  selectTimetable(timetableSelect.value, { scroll: true });
});

function applyExamples() {
  const ex = state.examples || GENERIC_EXAMPLES;
  courseSearch.placeholder = ex.nameWord
    ? 'e.g. ' + ex.code + ' or ' + ex.nameWord
    : 'Start typing a course code or name';
  const joined = ex.codeSection + (ex.codeSection2 ? ', ' + ex.codeSection2 : '');
  if (quickAddExample) quickAddExample.textContent = joined;
  quickAddInput.placeholder = joined;
}

// ---------------------------------------------------------- search & selection

function renderSearchResults() {
  searchResults.textContent = '';
  if (!state.sections.length) return;

  const groups = courseGroups(state.sections, courseSearch.value);
  if (!groups.length) {
    searchResults.appendChild(el('div', 'no-results', 'No courses match that - try just the code, e.g. "' + (state.examples || GENERIC_EXAMPLES).code + '".'));
    return;
  }

  groups.forEach((group) => {
    const groupEl = el('div', 'result-group');
    const head = el('div', 'result-group-head', group.code === group.name ? '' : group.code + ' ');
    head.appendChild(el('span', 'rg-name', group.name));
    groupEl.appendChild(head);

    group.sections.forEach((sec) => {
      const key = sectionKey(sec);
      const row = el('div', 'result-row');
      row.dataset.key = key;
      row.setAttribute('role', 'option');

      const main = el('div', 'result-row-main');
      main.appendChild(el('span', 'result-row-section', sec.section));
      const metaBits = [sec.teacher, sectionMeetingSummary(sec)].filter(Boolean);
      main.appendChild(el('span', 'result-row-meta', metaBits.join(' · ')));
      row.appendChild(main);

      const link = reviewLink(sec.teacher);
      if (link) row.appendChild(link);

      const addBtn = el('button', 'result-row-add', 'Add');
      addBtn.type = 'button';
      row.appendChild(addBtn);

      row.addEventListener('click', () => toggleSection(sec));
      groupEl.appendChild(row);
    });

    searchResults.appendChild(groupEl);
  });

  updateResultRowStates();
}

function updateResultRowStates() {
  searchResults.querySelectorAll('.result-row').forEach((row) => {
    const added = state.selected.has(row.dataset.key);
    row.classList.toggle('added', added);
    row.setAttribute('aria-selected', added ? 'true' : 'false');
    row.querySelector('.result-row-add').textContent = added ? 'Added' : 'Add';
  });
}

courseSearch.addEventListener('input', renderSearchResults);

function toggleSection(sec) {
  const key = sectionKey(sec);
  if (state.selected.has(key)) {
    state.selected.delete(key);
  } else {
    state.selected.set(key, sec);
    colorFor(sec); // claim a colour slot now so it stays stable
  }
  renderAll();
  queueSave();
}

function renderSelectedList() {
  selectedList.textContent = '';
  state.selected.forEach((sec) => {
    const li = el('li', 'selected-item');

    const swatch = el('span', 'selected-swatch');
    swatch.style.background = colorFor(sec);
    li.appendChild(swatch);

    const main = el('div', 'selected-main');
    main.appendChild(el('div', 'selected-title',
      (sec.code === sec.name ? '' : sec.code + ' · ') + sec.section));
    const metaBits = [sec.name, sec.teacher, sectionMeetingSummary(sec)].filter(Boolean);
    main.appendChild(el('div', 'selected-meta', metaBits.join(' · ')));
    li.appendChild(main);

    const link = reviewLink(sec.teacher);
    if (link) li.appendChild(link);

    const removeBtn = el('button', 'selected-remove', '×');
    removeBtn.type = 'button';
    removeBtn.setAttribute('aria-label', 'Remove ' + sec.code + ' ' + sec.section);
    removeBtn.addEventListener('click', () => toggleSection(sec));
    li.appendChild(removeBtn);

    selectedList.appendChild(li);
  });

  selectedCount.textContent = state.selected.size;
  emptySelectedHint.hidden = state.selected.size > 0;
  downloadBtn.disabled = state.selected.size === 0;
}

quickAddResolve.addEventListener('click', () => {
  quickAddFeedback.textContent = '';
  const tokens = quickAddInput.value.split(/[\n,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (!tokens.length) {
    quickAddFeedback.appendChild(el('div', 'qa-fail', 'Nothing to add - paste codes like "' + (state.examples || GENERIC_EXAMPLES).codeSection + '" first.'));
    return;
  }

  let changed = false;
  tokens.forEach((token) => {
    const result = resolveQuickAddToken(state.sections, token);
    if (!result.ok) {
      quickAddFeedback.appendChild(el('div', 'qa-fail', '✗ ' + token + ' - ' + result.reason));
      return;
    }
    const sec = result.section;
    const label = sec.code + ' ' + sec.section;
    if (state.selected.has(sectionKey(sec))) {
      quickAddFeedback.appendChild(el('div', 'qa-ok', '✓ ' + token + ' → ' + label + ' (already added)'));
    } else {
      state.selected.set(sectionKey(sec), sec);
      colorFor(sec);
      changed = true;
      quickAddFeedback.appendChild(el('div', 'qa-ok', '✓ ' + token + ' → ' + label + ' added'));
    }
  });
  if (changed) {
    renderAll();
    queueSave();
  }
});

// -------------------------------------------------------- conflicts and canvas

function currentEvents() {
  return selectedEvents(state.selected, durationDefaults());
}

function renderConflicts(events) {
  const conflicts = findConflicts(events);
  conflictBanner.hidden = conflicts.length === 0;
  if (!conflicts.length) return;

  conflictText.textContent = '';
  conflictText.appendChild(el('div', null,
    conflicts.length === 1 ? 'These two classes overlap:' : 'Some of your classes overlap:'));
  const list = el('ul');
  conflicts.forEach(([a, b]) => {
    list.appendChild(el('li', null,
      WEEKDAYS[a.dayIdx] + ': ' +
      a.sec.code + ' (' + a.sec.section + ') ' + fmtMinutes(a.start) + '–' + fmtMinutes(a.end) +
      ' ↔ ' +
      b.sec.code + ' (' + b.sec.section + ') ' + fmtMinutes(b.start) + '–' + fmtMinutes(b.end)));
  });
  conflictText.appendChild(list);
}

function renderCanvas(events) {
  if (!state.sections.length) return;
  const scale = Math.min(window.devicePixelRatio || 1, 2) * 1.25;
  renderTimetable(canvas.getContext('2d'), scale, { meta: state.meta, events, colorFor });
}

downloadBtn.addEventListener('click', () => {
  const exportCanvas = document.createElement('canvas');
  renderTimetable(exportCanvas.getContext('2d'), 3, { meta: state.meta, events: currentEvents(), colorFor });

  exportCanvas.toBlob((blob) => {
    if (!blob) return;
    const firstSec = state.selected.values().next().value;
    const name = firstSec
      ? 'timetable-' + firstSec.code.toLowerCase() + '.png'
      : 'my-timetable.png';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/png');
});

function renderAll() {
  const events = currentEvents();
  renderSelectedList();
  updateResultRowStates();
  updateBrowseAddStates();
  renderConflicts(events);
  renderCanvas(events);
}

// Class-length estimates only change the drawing, not what is saved.
theoryMinInput.addEventListener('input', renderAll);
labMinInput.addEventListener('input', renderAll);

// ---------------------------------------------------------------- the catalog

function renderBrowseStats() {
  browseStats.textContent = '';
  const courseCount = courseGroups(state.sections, '').length;
  const teacherCount = teacherCatalog(state.sections).filter((t) => t.name !== 'TBA').length;
  const stats = [
    [courseCount, courseCount === 1 ? 'course' : 'courses'],
    [teacherCount, teacherCount === 1 ? 'teacher' : 'teachers'],
    [state.sections.length, state.sections.length === 1 ? 'section' : 'sections'],
  ];
  stats.forEach(([n, label]) => {
    const chip = el('span', 'stat-chip');
    chip.appendChild(el('strong', null, String(n)));
    chip.appendChild(document.createTextNode(label));
    browseStats.appendChild(chip);
  });
}

function sectionRow(sec, showCourse) {
  const row = el('div', 'catalog-row');
  row.dataset.key = sectionKey(sec);

  const main = el('div', 'catalog-row-main');
  const title = el('div', 'catalog-row-title');
  if (showCourse) {
    if (sec.code !== sec.name) title.appendChild(el('strong', null, sec.code));
    title.appendChild(document.createTextNode(' ' + sec.name + ' '));
  }
  title.appendChild(el('span', 'catalog-row-section', sec.section));
  main.appendChild(title);

  const metaBits = [sec.teacher, sectionMeetingSummary(sec)].filter(Boolean);
  if (metaBits.length) main.appendChild(el('div', 'catalog-row-meta', metaBits.join(' · ')));
  row.appendChild(main);

  const link = reviewLink(sec.teacher);
  if (link) row.appendChild(link);

  const add = el('button', 'catalog-add');
  add.type = 'button';
  add.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleSection(sec);
  });
  row.appendChild(add);

  return row;
}

function updateBrowseAddStates() {
  browseContent.querySelectorAll('.catalog-row').forEach((row) => {
    const added = state.selected.has(row.dataset.key);
    row.classList.toggle('added', added);
    row.querySelector('.catalog-add').textContent = added ? 'Added' : 'Add';
  });
  const n = state.selected.size;
  browseFootCount.textContent = n
    ? n + (n === 1 ? ' section added' : ' sections added')
    : 'Nothing added yet';
}

function renderBrowseCourses(tokens) {
  const grid = el('div', 'course-grid');
  let shown = 0;
  courseGroups(state.sections, '').forEach((group) => {
    const teachers = [];
    group.sections.forEach((sec) => {
      if (sec.teacher && !teachers.includes(sec.teacher)) teachers.push(sec.teacher);
    });
    const hay = group.code + ' ' + group.name + ' ' + teachers.join(' ') + ' ' +
      group.sections.map((s) => s.section).join(' ');
    if (!matchesFilter(hay, tokens)) return;
    shown++;

    const card = el('details', 'course-card');
    const summary = el('summary', 'course-card-summary');

    const top = el('div', 'course-card-top');
    top.appendChild(el('span', 'course-code', group.code));
    if (/\blab\b/i.test(group.name)) top.appendChild(el('span', 'lab-tag', 'Lab'));
    summary.appendChild(top);

    summary.appendChild(el('div', 'course-name', group.name));

    const n = group.sections.length;
    let meta = n + (n === 1 ? ' section' : ' sections');
    if (teachers.length) meta += ' · ' + teachers.join(', ');
    summary.appendChild(el('div', 'course-meta', meta));
    card.appendChild(summary);

    const rows = el('div', 'catalog-rows');
    group.sections.forEach((sec) => rows.appendChild(sectionRow(sec, false)));
    card.appendChild(rows);

    if (tokens.length) card.open = true;
    grid.appendChild(card);
  });

  if (!shown) {
    browseContent.appendChild(el('div', 'no-results', 'Nothing in the catalog matches that filter.'));
  } else {
    browseContent.appendChild(grid);
  }
}

function renderBrowseTeachers(tokens) {
  const list = el('div', 'teacher-list');
  let shown = 0;
  teacherCatalog(state.sections).forEach((teacher) => {
    const courses = Array.from(teacher.courses.values());
    const hay = teacher.name + ' ' + courses.map((c) => c.code + ' ' + c.name).join(' ');
    if (!matchesFilter(hay, tokens)) return;
    shown++;

    const row = el('details', 'teacher-row');

    const head = el('summary', 'teacher-head');
    head.appendChild(el('span', 'teacher-avatar', teacherInitials(teacher.name)));
    head.appendChild(el('span', 'teacher-name', teacher.name));
    const nc = courses.length;
    head.appendChild(el('span', 'teacher-load',
      nc + (nc === 1 ? ' course' : ' courses') + ' · ' +
      teacher.sectionCount + (teacher.sectionCount === 1 ? ' section' : ' sections')));
    const link = reviewLink(teacher.name);
    if (link) head.appendChild(link);
    row.appendChild(head);

    const rows = el('div', 'catalog-rows');
    state.sections.forEach((sec) => {
      if ((sec.teacher || 'TBA') !== teacher.name) return;
      rows.appendChild(sectionRow(sec, true));
    });
    row.appendChild(rows);

    if (tokens.length) row.open = true;
    list.appendChild(row);
  });

  if (!shown) {
    browseContent.appendChild(el('div', 'no-results', 'No teacher matches that filter.'));
  } else {
    browseContent.appendChild(list);
  }
}

function renderBrowseSections(tokens) {
  const list = el('div', 'section-list');
  let shown = 0;

  sectionCatalog(state.sections).forEach((base) => {
    const courseText = [];
    base.subList.forEach((sub) => {
      sub.sections.forEach((sec) => {
        courseText.push(sec.code + ' ' + sec.name + ' ' + (sec.teacher || ''));
      });
    });
    const hay = base.label + ' ' + base.subList.map((s) => s.label).join(' ') + ' ' + courseText.join(' ');
    if (!matchesFilter(hay, tokens)) return;
    shown++;

    const group = el('details', 'section-group');

    const head = el('summary', 'section-head');
    head.appendChild(el('span', 'section-label', base.label));
    head.appendChild(el('span', 'section-load',
      base.total + (base.total === 1 ? ' class' : ' classes')));

    const subs = base.subList.filter((s) => s.label !== base.label);
    if (subs.length) {
      const tags = el('span', 'section-subs');
      subs.forEach((sub) => tags.appendChild(el('span', 'sub-tag', sub.label)));
      head.appendChild(tags);
    }
    group.appendChild(head);

    base.subList.forEach((sub) => {
      const block = el('div', 'sub-block');

      const subHead = el('div', 'sub-head');
      subHead.appendChild(el('span', 'sub-head-label', sub.label));
      subHead.appendChild(el('span', 'sub-head-count',
        sub.sections.length + (sub.sections.length === 1 ? ' class' : ' classes') +
        (sub.isSub ? ' · sub-section' : '')));
      block.appendChild(subHead);

      const rows = el('div', 'catalog-rows');
      sub.sections.forEach((sec) => rows.appendChild(sectionRow(sec, true)));
      block.appendChild(rows);

      group.appendChild(block);
    });

    if (tokens.length) group.open = true;
    list.appendChild(group);
  });

  if (!shown) {
    browseContent.appendChild(el('div', 'no-results', 'No section matches that filter.'));
  } else {
    browseContent.appendChild(list);
  }
}

function renderBrowse() {
  if (!state.sections.length) return;
  renderBrowseStats();
  browseContent.textContent = '';
  const tokens = browseFilter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (state.browseView === 'teachers') renderBrowseTeachers(tokens);
  else if (state.browseView === 'sections') renderBrowseSections(tokens);
  else renderBrowseCourses(tokens);
  updateBrowseAddStates();
}

function setBrowseView(view) {
  state.browseView = view;
  [[tabCourses, 'courses'], [tabTeachers, 'teachers'], [tabSections, 'sections']].forEach(([tab, name]) => {
    const isActive = view === name;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  browseContent.scrollTop = 0;
  renderBrowse();
}

tabCourses.addEventListener('click', () => setBrowseView('courses'));
tabTeachers.addEventListener('click', () => setBrowseView('teachers'));
tabSections.addEventListener('click', () => setBrowseView('sections'));

function openBrowse() {
  if (!state.sections.length) return;
  renderBrowse();
  if (!browseModal.open) {
    if (browseModal.showModal) browseModal.showModal();
    else browseModal.setAttribute('open', '');
  }
  browseFilter.focus({ preventScroll: true });
}

function closeBrowse() {
  if (browseModal.close) browseModal.close();
  else browseModal.removeAttribute('open');
}

browseOpenBtn.addEventListener('click', openBrowse);
browseJump.addEventListener('click', openBrowse);
browseCloseBtn.addEventListener('click', closeBrowse);
browseDoneBtn.addEventListener('click', closeBrowse);

browseModal.addEventListener('click', (ev) => {
  // A click on the backdrop lands on the <dialog> element itself.
  if (ev.target === browseModal) closeBrowse();
});

browseFilter.addEventListener('input', renderBrowse);

campusSelect.value = state.reviewCampus;
campusSelect.addEventListener('change', () => {
  state.reviewCampus = campusSelect.value;
  storageSet(CAMPUS_STORAGE_KEY, state.reviewCampus);
  // Review links embed the campus, so rebuild everything that shows them.
  renderSearchResults();
  renderSelectedList();
  renderBrowse();
});

// ---------------------------------------------------------------------- start

async function boot() {
  const user = await requireUser();
  if (!user) return; // redirecting to the login or pending page
  state.user = user;
  renderHeader(user);
  page.hidden = false;
  await loadTimetableList({ preselect: storageGet(TIMETABLE_STORAGE_KEY) });
}

boot();
