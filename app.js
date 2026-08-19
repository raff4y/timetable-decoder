(function () {
  'use strict';

  var PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
  var CANVAS_BG = '#fcfcfb';
  var CANVAS_GRIDLINE = '#e1e0d9';
  var CANVAS_INK = '#0b0b0b';
  var CANVAS_MUTED = '#898781';
  var FONT_STACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';

  var WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var DAY_PREFIXES = {
    mon: 0, tue: 1, tues: 1, wed: 2, thu: 3, thur: 3, thurs: 3, fri: 4, sat: 5, sun: 6
  };

  var HEADER_COLS = ['code', 'course', 'section', 'teacher', 'day', 'time', 'room', 'batch'];
  var REQUIRED_COLS = ['code', 'course', 'section', 'teacher', 'day', 'time', 'room'];

  var NUCESRATE_SEARCH = 'https://nucesrate.vercel.app/professors';
  var CAMPUSES = ['Islamabad', 'Karachi', 'Lahore', 'Peshawar', 'Chiniot-Faisalabad'];
  var CAMPUS_STORAGE_KEY = 'td.reviewCampus';

  var $ = function (id) { return document.getElementById(id); };
  var fileInput = $('file-input');
  var dropzone = $('dropzone');
  var loadSampleBtn = $('load-sample-btn');
  var uploadStatus = $('upload-status');
  var buildPanel = $('build-panel');
  var imagePanel = $('image-panel');
  var fileSummary = $('file-summary');
  var courseSearch = $('course-search');
  var searchResults = $('search-results');
  var quickAddInput = $('quick-add-input');
  var quickAddResolve = $('quick-add-resolve');
  var quickAddFeedback = $('quick-add-feedback');
  var selectedList = $('selected-list');
  var selectedCount = $('selected-count');
  var emptySelectedHint = $('empty-selected-hint');
  var conflictBanner = $('conflict-banner');
  var conflictText = $('conflict-text');
  var theoryMinInput = $('theory-min');
  var labMinInput = $('lab-min');
  var canvas = $('timetable-canvas');
  var downloadBtn = $('download-btn');
  var browsePanel = $('browse-panel');
  var browseStats = $('browse-stats');
  var browseContent = $('browse-content');
  var browseFilter = $('browse-filter');
  var tabCourses = $('tab-courses');
  var tabTeachers = $('tab-teachers');
  var campusSelect = $('campus-select');
  var advancedHint = document.querySelector('.advanced-hint');
  var defaultAdvancedHint = advancedHint.textContent;

  var state = {
    meta: null,
    sections: [],
    selected: new Map(),
    colorAssignments: new Map(),
    nextColorSlot: 0,
    browseView: 'courses',
    reviewCampus: ''
  };

  try {
    var savedCampus = window.localStorage.getItem(CAMPUS_STORAGE_KEY);
    if (savedCampus && CAMPUSES.indexOf(savedCampus) !== -1) state.reviewCampus = savedCampus;
  } catch (e) {}

  function sectionKey(sec) { return sec.code + '|' + sec.section; }

  function baseNameKey(name) {

    return String(name).replace(/\s*[-–—]?\s*\(?\blab\b\)?\s*$/i, '').trim().toLowerCase();
  }

  function colorForSection(sec) {
    var key = baseNameKey(sec.name);
    var slot = state.colorAssignments.get(key);
    if (slot === undefined) {
      slot = state.nextColorSlot++;
      state.colorAssignments.set(key, slot);
    }
    var hex = PALETTE[slot % PALETTE.length];
    var pass = Math.floor(slot / PALETTE.length);
    if (pass > 0) hex = shadeHex(hex, pass % 2 === 1 ? 0.18 : -0.18);
    return hex;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function reviewSearchName(teacher) {

    var name = String(teacher || '').replace(/\([^)]*\)/g, '');
    var honorific = /^\s*(?:dr|mr|mrs|ms|miss|prof|professor|engr|sir|madam|mam)\b\.?\s+/i;
    while (honorific.test(name)) name = name.replace(honorific, '');
    return name.replace(/\s+/g, ' ').trim();
  }

  function hasReviewLink(teacher) {
    var name = reviewSearchName(teacher);
    if (name.length < 2) return false;

    if (/^(tba|tbd|n\/?a|staff)$/i.test(name)) return false;
    if (/^(lab\s*(engineer|instructor|attendant)|teaching\s*assistant|ta|visiting\s*faculty|to\s*be\s*(announced|decided))\b/i.test(name)) return false;
    return true;
  }

  function reviewUrl(teacher) {
    var url = NUCESRATE_SEARCH + '?pg=1&prof=' + encodeURIComponent(reviewSearchName(teacher));
    if (state.reviewCampus) url += '&campus=' + encodeURIComponent(state.reviewCampus);
    return url;
  }

  function reviewLink(teacher, label) {
    if (!hasReviewLink(teacher)) return null;
    var a = el('a', 'prof-link');
    a.href = reviewUrl(teacher);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.appendChild(el('span', 'prof-link-text', label || 'Reviews'));
    a.appendChild(el('span', 'prof-link-arrow', '↗'));
    a.setAttribute('aria-label', 'See student reviews for ' + reviewSearchName(teacher) + ' on NUCESRate (opens in a new tab)');
    a.title = a.getAttribute('aria-label');

    a.addEventListener('click', function (ev) { ev.stopPropagation(); });
    return a;
  }

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex);
    var n = parseInt(m[1], 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }

  function shadeHex(hex, amount) {

    var rgb = hexToRgb(hex);
    var target = amount > 0 ? 255 : 0;
    var f = Math.abs(amount);
    var out = rgb.map(function (c) { return Math.round(c + (target - c) * f); });
    return '#' + out.map(function (c) { return c.toString(16).padStart(2, '0'); }).join('');
  }

  function relativeLuminance(hex) {
    var rgb = hexToRgb(hex).map(function (c) {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }

  function contrastRatio(l1, l2) {
    var hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  function labelColorOn(fillHex) {
    var l = relativeLuminance(fillHex);
    return contrastRatio(l, 1) >= contrastRatio(l, relativeLuminance(CANVAS_INK))
      ? '#ffffff' : CANVAS_INK;
  }

  function parseTimeToMinutes(raw) {
    var s = String(raw).trim();
    var m = /^(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?/i.exec(s);
    if (m) {
      var h = parseInt(m[1], 10) % 12;
      if (m[3].toLowerCase() === 'p') h += 12;
      return h * 60 + parseInt(m[2], 10);
    }
    m = /^(\d{1,2}):(\d{2})\s*$/.exec(s);
    if (m) {
      var h24 = parseInt(m[1], 10), min = parseInt(m[2], 10);

      if (h24 >= 1 && h24 < 7) h24 += 12;
      return h24 * 60 + min;
    }
    return null;
  }

  function parseDay(raw) {
    var s = String(raw).trim().toLowerCase();
    if (!s) return null;
    for (var prefix in DAY_PREFIXES) {
      if (s.slice(0, prefix.length) === prefix) return DAY_PREFIXES[prefix];
    }
    return null;
  }

  function fmtMinutes(min) {
    var h = Math.floor(min / 60), m = min % 60;
    var suffix = h < 12 ? 'am' : 'pm';
    var h12 = ((h + 11) % 12) + 1;
    return h12 + ':' + String(m).padStart(2, '0') + suffix;
  }

  function fmtHourLabel(hour) {
    var h12 = ((hour + 11) % 12) + 1;
    return h12 + (hour < 12 ? ' AM' : ' PM');
  }

  function getTheoryMin() {
    var v = parseInt(theoryMinInput.value, 10);
    return isFinite(v) && v > 0 ? v : 80;
  }

  function getLabMin() {
    var v = parseInt(labMinInput.value, 10);
    return isFinite(v) && v > 0 ? v : 150;
  }

  function meetingIsLab(sec, meeting) {
    return sec.nameIsLab || /lab/i.test(meeting.room);
  }

  function meetingDuration(sec, meeting) {

    if (meeting.durMin) return meeting.durMin;
    return meetingIsLab(sec, meeting) ? getLabMin() : getTheoryMin();
  }

  function sectionMeetingSummary(sec) {
    var abbrs = sec.meetings.map(function (m) { return WEEKDAYS[m.dayIdx].slice(0, 3); });
    var times = sec.meetings.map(function (m) { return m.rawTime; });
    var allSameTime = times.every(function (t) { return t === times[0]; });
    var summary = allSameTime && times.length
      ? abbrs.join('/') + ' ' + times[0]
      : sec.meetings.map(function (m, i) { return abbrs[i] + ' ' + m.rawTime; }).join(', ');
    var rooms = sec.meetings.map(function (m) { return m.room; }).filter(Boolean);
    var uniqueRooms = rooms.filter(function (r, i) { return rooms.indexOf(r) === i; });
    if (uniqueRooms.length === 1) summary += ' · ' + uniqueRooms[0];
    return summary;
  }

  function findHeaderRow(rows) {
    var best = null;
    var limit = Math.min(rows.length, 10);
    for (var i = 0; i < limit; i++) {
      var row = rows[i] || [];
      var colMap = {};
      var score = 0;
      for (var c = 0; c < row.length; c++) {
        var cell = String(row[c]).trim().toLowerCase();
        if (HEADER_COLS.indexOf(cell) !== -1 && colMap[cell] === undefined) {
          colMap[cell] = c;
          if (REQUIRED_COLS.indexOf(cell) !== -1) score++;
        }
      }
      if (!best || score > best.score) best = { rowIdx: i, score: score, colMap: colMap };
    }
    return best && best.score >= 5 &&
      best.colMap.day !== undefined && best.colMap.time !== undefined ? best : null;
  }

  function finishSections(byKey, emptyError) {
    var sections = Array.from(byKey.values());
    sections.forEach(function (sec) {
      sec.meetings.sort(function (a, b) { return (a.dayIdx - b.dayIdx) || (a.startMin - b.startMin); });
    });
    sections.sort(function (a, b) {
      return a.code.localeCompare(b.code) || a.section.localeCompare(b.section);
    });
    if (!sections.length) throw new Error(emptyError);
    return sections;
  }

  function findSemester(title, fileName) {
    var re = /(spring|summer|fall|winter)\s*[-']?\s*(\d{4})/i;
    var m = re.exec(title) || re.exec(fileName || '');
    return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() + ' ' + m[2] : '';
  }

  function titleAboveRow(rows, rowIdx) {
    var title = '';
    for (var t = 0; t < rowIdx; t++) {
      (rows[t] || []).forEach(function (cell) {
        var s = String(cell).trim();
        if (s.length > title.length) title = s;
      });
    }
    return title;
  }

  function parseFlatSheet(sheet, fileName) {
    var col = sheet.header.colMap;
    var rows = sheet.rows;

    var title = titleAboveRow(rows, sheet.header.rowIdx);
    var deptMatch = /\[([^\]]+)\]/.exec(title);
    var meta = {
      title: title,
      department: deptMatch ? deptMatch[1].trim() : '',
      semester: findSemester(title, fileName),
      fileName: fileName || ''
    };

    var byKey = new Map();
    for (var i = sheet.header.rowIdx + 1; i < rows.length; i++) {
      var row = rows[i] || [];
      var code = String(row[col.code] || '').trim();
      var name = String(row[col.course] || '').trim();
      var section = String(row[col.section] || '').trim();
      if (!code || !section) continue;

      var dayIdx = parseDay(row[col.day]);
      var startMin = parseTimeToMinutes(row[col.time]);
      if (dayIdx === null || startMin === null) continue;

      var key = code + '|' + section;
      var sec = byKey.get(key);
      if (!sec) {
        sec = {
          code: code,
          name: name,
          section: section,
          teacher: String(row[col.teacher] || '').trim(),
          batch: col.batch !== undefined ? String(row[col.batch] || '').trim() : '',
          nameIsLab: /\blab\b/i.test(name),
          meetings: []
        };
        byKey.set(key, sec);
      }
      if (!sec.teacher) sec.teacher = String(row[col.teacher] || '').trim();

      var duplicate = sec.meetings.some(function (m) {
        return m.dayIdx === dayIdx && m.startMin === startMin;
      });
      if (!duplicate) {
        sec.meetings.push({
          dayIdx: dayIdx,
          startMin: startMin,
          rawTime: String(row[col.time]).trim(),
          room: String(row[col.room] || '').trim(),
          durMin: null
        });
      }
    }

    return {
      meta: meta,
      sections: finishSections(byKey, 'Found the course-list sheet but no readable rows in it.')
    };
  }

  var CLOCK_RE = /(\d{1,2})[:.](\d{2})\s*(a\.?\s*m\.?|p\.?\s*m\.?)?/gi;
  var RANGE_SEP_RE = /^[\s.]*(?:to|till|until|[-–—])[\s.]*$/i;

  function clockToMinutes(hour, minute, meridiem) {
    var h = hour;
    if (meridiem) {
      h = h % 12;
      if (/p/i.test(meridiem)) h += 12;
    } else if (h >= 1 && h < 7) {
      h += 12;
    }
    return h * 60 + minute;
  }

  function findTimeRange(text) {
    var s = String(text);
    CLOCK_RE.lastIndex = 0;
    var a = CLOCK_RE.exec(s);
    if (!a) return null;
    var b = CLOCK_RE.exec(s);
    if (!b) return null;
    if (!RANGE_SEP_RE.test(s.slice(a.index + a[0].length, b.index))) return null;
    var startMin = clockToMinutes(parseInt(a[1], 10), parseInt(a[2], 10), a[3]);
    var endMin = clockToMinutes(parseInt(b[1], 10), parseInt(b[2], 10), b[3]);
    while (endMin <= startMin) endMin += 12 * 60;
    if (endMin - startMin > 8 * 60) return null;
    return { startMin: startMin, endMin: endMin, index: a.index, end: b.index + b[0].length };
  }

  function parsePeriodHeader(text) {
    var s = String(text).trim();
    if (!s) return null;
    var range = findTimeRange(s);
    if (!range) return null;
    var rest = (s.slice(0, range.index) + s.slice(range.end)).replace(/[\s.:·-]/g, '');
    return rest ? null : range;
  }

  function detectGrid(rows) {
    var limit = Math.min(rows.length, 10);
    for (var i = 0; i < limit; i++) {
      var row = rows[i] || [];
      var periodCols = [];
      for (var c = 0; c < row.length; c++) {
        var range = parsePeriodHeader(row[c]);
        if (range) periodCols.push({ col: c, startMin: range.startMin, endMin: range.endMin });
      }
      if (periodCols.length >= 3) {

        var step = (periodCols[1].startMin - periodCols[0].startMin) /
                   (periodCols[1].col - periodCols[0].col);
        if (!(step > 0 && step <= 60)) step = 10;

        var dataStart = i + 1;
        for (var j = i + 1; j < Math.min(rows.length, i + 4); j++) {
          var cells = (rows[j] || []).map(function (x) { return String(x).trim().toLowerCase(); });
          if (cells.indexOf('days') !== -1 || cells.indexOf('day') !== -1) {
            dataStart = j + 1;
            break;
          }
        }
        return { periodRow: i, periodCols: periodCols, step: step, dataStart: dataStart };
      }
    }
    return null;
  }

  function periodForCol(grid, c) {
    var p = grid.periodCols[0];
    for (var i = 0; i < grid.periodCols.length; i++) {
      if (grid.periodCols[i].col <= c) p = grid.periodCols[i];
      else break;
    }
    return p;
  }

  function gridTimeForCol(grid, c) {
    var p = periodForCol(grid, c);
    return p.startMin + (c - p.col) * grid.step;
  }

  var SECTION_TOKEN_RE = /([A-Z]{2,6}\d?-\d[A-Za-z]?\d?(?:\/\d[A-Za-z]?\d?)?)/;

  function parseGridCellEntries(text) {
    var s = String(text).replace(/\s+/g, ' ').trim();
    if (!s) return [];

    var range = findTimeRange(s);
    if (range) s = (s.slice(0, range.index) + ' ' + s.slice(range.end)).replace(/\s+/g, ' ').trim();

    var groups = [];
    var paren = /\(([^()]*)\)/g;
    var m;
    while ((m = paren.exec(s)) !== null) {
      groups.push({ section: m[1].trim(), start: m.index, end: paren.lastIndex });
    }

    var entries = [];
    var cursor = 0;
    var lastTitle = '';
    for (var i = 0; i < groups.length; i++) {
      var title = s.slice(cursor, groups[i].start).replace(/^[\s&\/,;:-]+/, '').trim() || lastTitle;
      var tailEnd = i + 1 < groups.length ? groups[i + 1].start : s.length;
      var tail = s.slice(groups[i].end, tailEnd);
      cursor = tailEnd;
      if (i + 1 < groups.length) {

        var joiner = /\s[&\/+]\s/.exec(tail);
        if (joiner) {
          cursor = groups[i].end + joiner.index + joiner[0].length;
          tail = tail.slice(0, joiner.index);
        }
      }
      var teacher = tail.replace(/^[\s:,-]+/, '').replace(/[\s&\/,;:-]+$/, '').trim();
      lastTitle = title;
      if (title && groups[i].section) {
        entries.push({ title: title, section: groups[i].section, teacher: teacher, range: range });
      }
    }

    if (!entries.length) {

      var token = SECTION_TOKEN_RE.exec(s);
      if (token) {
        var before = s.slice(0, token.index).replace(/[\s()\[\],;:-]+$/, '').trim();
        var after = s.slice(token.index + token[0].length).replace(/^[\s()\[\],;:-]+/, '').trim();
        if (before) entries.push({ title: before, section: token[1], teacher: after, range: range });
      }
    }
    return entries;
  }

  function findCourseListHeader(rows) {
    var limit = Math.min(rows.length, 6);
    for (var i = 0; i < limit; i++) {
      var row = rows[i] || [];
      var map = {};
      for (var c = 0; c < row.length; c++) {
        var cell = String(row[c]).trim().toLowerCase();
        if (cell === 'code' && map.code === undefined) map.code = c;
        else if (/^course(\s*(title|name))?$/.test(cell) && map.name === undefined) map.name = c;
        else if (cell === 'section' && map.section === undefined) map.section = c;
        else if (/^(instructor(\s*name)?|teacher)$/.test(cell) && map.teacher === undefined) map.teacher = c;
        else if (/^course\s*short/.test(cell) && map.shortTitle === undefined) map.shortTitle = c;
        else if (/^instructor\s*short/.test(cell) && map.shortTeacher === undefined) map.shortTeacher = c;
        else if (/^duration/.test(cell) && map.duration === undefined) map.duration = c;
        else if (/^offered/.test(cell) && map.batch === undefined) map.batch = c;
      }
      if (map.code !== undefined && map.section !== undefined && map.name !== undefined) {
        return { rowIdx: i, colMap: map };
      }
    }
    return null;
  }

  function parseGridWorkbook(sheetsData, grids, fileName) {
    var tight = function (s) { return String(s).replace(/[^a-z0-9]/gi, '').toLowerCase(); };

    var baseSectionKey = function (s) { return tight(s).replace(/([a-z])\d$/, '$1'); };

    var plainTitle = function (s) { return String(s).replace(/\s*\([^)]*\)\s*$/, '').trim(); };
    var cleanTeacher = function (s) {
      var t = String(s || '').trim();
      return /^(added|tba|tbd|n\/?a|-+)$/i.test(t) ? '' : t;
    };

    var infoByKey = new Map();
    var infoByBase = new Map();
    var titleIndex = [];
    var titleSlot = new Map();

    function indexCourse(info, titles, section) {
      titles.forEach(function (t) {
        if (!t) return;
        var exactKey = tight(t) + '|' + tight(section);
        if (!infoByKey.has(exactKey)) infoByKey.set(exactKey, info);

        var bk = tight(plainTitle(t));
        if (!bk) return;
        var bsk = baseSectionKey(section);
        if (!infoByBase.has(bk + '|' + bsk)) infoByBase.set(bk + '|' + bsk, info);

        var slot = titleSlot.get(bk);
        if (slot === undefined) {
          slot = titleIndex.length;
          titleSlot.set(bk, slot);
          titleIndex.push({ key: bk, bySection: new Map(), first: info });
        }
        if (!titleIndex[slot].bySection.has(bsk)) titleIndex[slot].bySection.set(bsk, info);
      });
    }

    function lookupCourse(title, section) {
      var exact = infoByKey.get(tight(title) + '|' + tight(section));
      if (exact) return { info: exact, exact: true };

      var bk = tight(plainTitle(title));
      var bsk = baseSectionKey(section);
      var loose = infoByBase.get(bk + '|' + bsk);
      if (loose) return { info: loose, exact: false };

      var best = null;
      for (var i = 0; i < titleIndex.length; i++) {
        var entry = titleIndex[i];
        if (entry.key.length < 10) continue;
        if (bk.indexOf(entry.key) !== 0 && entry.key.indexOf(bk) !== 0) continue;
        if (!best || entry.key.length > best.key.length) best = entry;
      }
      if (!best) return null;
      return { info: best.bySection.get(bsk) || best.first, exact: false };
    }

    sheetsData.forEach(function (sd) {
      if (detectGrid(sd.rows)) return;
      var header = findCourseListHeader(sd.rows);
      if (!header) return;
      var map = header.colMap;
      for (var i = header.rowIdx + 1; i < sd.rows.length; i++) {
        var row = sd.rows[i] || [];
        var code = String(row[map.code] || '').trim();
        var section = String(row[map.section] || '').trim();
        if (!code || !section) continue;
        var name = String(row[map.name] || '').trim();
        var shortTitle = map.shortTitle !== undefined ? String(row[map.shortTitle] || '').trim() : '';
        indexCourse({
          code: code,
          name: name || shortTitle,
          teacher: map.teacher !== undefined ? cleanTeacher(row[map.teacher]) : '',
          batch: map.batch !== undefined ? String(row[map.batch] || '').trim() : '',
          duration: map.duration !== undefined ? (parseInt(row[map.duration], 10) || null) : null
        }, [shortTitle, name], section);
      }
    });

    var byKey = new Map();

    function addMeeting(entry, place) {
      var found = lookupCourse(entry.title, entry.section);
      var info = found ? found.info : null;
      var gridTeacher = cleanTeacher(entry.teacher);

      var teacher = found && found.exact
        ? (info.teacher || gridTeacher)
        : (gridTeacher || (info && info.teacher) || '');

      var code = info ? info.code : entry.title;
      var name = info ? info.name : entry.title;
      var key = code + '|' + entry.section;
      var sec = byKey.get(key);
      if (!sec) {
        sec = {
          code: code,
          name: name,
          section: entry.section,
          teacher: teacher,
          batch: (info && info.batch) || '',
          nameIsLab: /\blab\b/i.test(name),
          meetings: []
        };
        byKey.set(key, sec);
      }
      if (!sec.teacher) sec.teacher = teacher;

      var dup = sec.meetings.some(function (mm) {
        return mm.dayIdx === place.dayIdx && mm.startMin === place.startMin;
      });
      if (dup) return;

      var durMin = null;
      if (entry.range) durMin = entry.range.endMin - entry.range.startMin;
      else if (place.span >= 2) durMin = Math.round(place.span * place.step);
      else if (info && info.duration) durMin = info.duration;
      else if (place.period && place.period.endMin > place.startMin) {
        durMin = place.period.endMin - place.startMin;
      }

      sec.meetings.push({
        dayIdx: place.dayIdx,
        startMin: place.startMin,
        rawTime: fmtMinutes(place.startMin),
        room: place.room,
        durMin: durMin
      });
    }

    var chosen = grids.filter(function (g) { return /combined/i.test(g.name); });
    if (!chosen.length) chosen = grids;

    chosen.forEach(function (g) {
      var grid = g.grid;
      var rows = g.rows;
      var firstPeriodCol = grid.periodCols[0].col;
      var spans = {};
      (g.ws['!merges'] || []).forEach(function (m) {
        if (m.s.r === m.e.r) spans[m.s.r + ',' + m.s.c] = m.e.c - m.s.c + 1;
      });

      var currentDay = null;
      for (var r = grid.dataStart; r < rows.length; r++) {
        var row = rows[r] || [];
        var dayCell = String(row[0] || '').trim();
        if (dayCell) currentDay = parseDay(dayCell);
        var room = String(row[1] || '').trim();
        if (currentDay === null || !room) continue;

        for (var c = Math.max(2, firstPeriodCol); c < row.length; c++) {
          var entries = parseGridCellEntries(row[c]);
          if (!entries.length) continue;
          var span = spans[r + ',' + c] || 1;
          var period = periodForCol(grid, c);
          var colStart = gridTimeForCol(grid, c);
          entries.forEach(function (entry) {
            addMeeting(entry, {
              dayIdx: currentDay,
              room: room,
              startMin: entry.range ? entry.range.startMin : colStart,
              span: span,
              step: grid.step,
              period: period
            });
          });
        }
      }
    });

    var title = titleAboveRow(chosen[0].rows, chosen[0].grid.periodRow);
    var bracketed = /\[([^\]]+)\]/.exec(title);
    var meta = {
      title: title,
      department: bracketed ? bracketed[1].trim() : title.replace(/\s*time\s*table.*$/i, '').trim(),
      semester: findSemester(title, fileName),
      fileName: fileName || ''
    };

    return {
      meta: meta,
      sections: finishSections(byKey, 'Found a timetable grid but no readable class entries in it.')
    };
  }

  function parseWorkbook(arrayBuffer, fileName) {
    var wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
    var sheetsData = wb.SheetNames.map(function (name) {
      return {
        name: name,
        ws: wb.Sheets[name],
        rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' })
      };
    });

    var candidates = [];
    sheetsData.forEach(function (sd) {
      var header = findHeaderRow(sd.rows);
      if (header) {
        candidates.push({
          name: sd.name, rows: sd.rows, header: header,
          nameBonus: /list/i.test(sd.name) && /course/i.test(sd.name) ? 1 : 0
        });
      }
    });
    if (candidates.length) {
      candidates.sort(function (a, b) {
        return (b.header.score - a.header.score) || (b.nameBonus - a.nameBonus);
      });
      return parseFlatSheet(candidates[0], fileName);
    }

    var grids = [];
    sheetsData.forEach(function (sd) {
      var grid = detectGrid(sd.rows);
      if (grid) grids.push({ name: sd.name, ws: sd.ws, rows: sd.rows, grid: grid });
    });
    if (grids.length) return parseGridWorkbook(sheetsData, grids, fileName);

    throw new Error('Could not recognize this timetable format — expected either a flat "List of Courses" sheet (Code/Course/Section/Teacher/Day/Time/Room) or a period-grid timetable sheet.');
  }

  function setUploadStatus(message, kind) {
    uploadStatus.textContent = message;
    uploadStatus.classList.toggle('error', kind === 'error');
    uploadStatus.classList.toggle('success', kind === 'success');
  }

  function loadArrayBuffer(arrayBuffer, fileName) {
    try {
      var parsed = parseWorkbook(arrayBuffer, fileName);
    } catch (err) {
      setUploadStatus(err.message || 'Could not read that file.', 'error');
      return;
    }

    state.meta = parsed.meta;
    state.sections = parsed.sections;
    state.selected = new Map();
    state.colorAssignments = new Map();
    state.nextColorSlot = 0;

    var courseCount = new Set(parsed.sections.map(function (s) { return s.code; })).size;
    var parts = [];
    if (parsed.meta.department) parts.push(parsed.meta.department);
    if (parsed.meta.semester) parts.push(parsed.meta.semester);
    parts.push(courseCount + ' courses · ' + parsed.sections.length + ' sections found');
    fileSummary.textContent = parts.join(' — ');

    var allExplicit = parsed.sections.every(function (sec) {
      return sec.meetings.every(function (m) { return m.durMin; });
    });
    theoryMinInput.disabled = allExplicit;
    labMinInput.disabled = allExplicit;
    advancedHint.textContent = allExplicit
      ? 'This file lists the exact length of every class, so no estimates are needed — these inputs are disabled.'
      : defaultAdvancedHint;

    setUploadStatus('Loaded ' + (fileName || 'file') + ' — ' + courseCount + ' courses.', 'success');
    buildPanel.hidden = false;
    imagePanel.hidden = false;
    browsePanel.hidden = false;

    quickAddFeedback.textContent = '';
    courseSearch.value = '';
    browseFilter.value = '';
    renderSearchResults();
    renderBrowse();
    renderAll();
    buildPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function handleFile(file) {
    if (!file) return;
    if (!/\.xlsx?$/i.test(file.name)) {
      setUploadStatus('That doesn’t look like an Excel file — expected .xlsx or .xls.', 'error');
      return;
    }
    setUploadStatus('Reading ' + file.name + '…');
    file.arrayBuffer().then(function (buf) {
      loadArrayBuffer(buf, file.name);
    }, function () {
      setUploadStatus('Could not read the file from disk.', 'error');
    });
  }

  fileInput.addEventListener('change', function () {
    handleFile(fileInput.files[0]);
    fileInput.value = '';
  });

  ['dragover', 'dragenter'].forEach(function (type) {
    dropzone.addEventListener(type, function (e) {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'dragend'].forEach(function (type) {
    dropzone.addEventListener(type, function () {
      dropzone.classList.remove('dragover');
    });
  });
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  var SAMPLE_FILE = 'EE Time Table (Fall 2026) v1.0.xlsx';
  loadSampleBtn.addEventListener('click', function () {
    setUploadStatus('Fetching the sample timetable…');
    fetch(encodeURI(SAMPLE_FILE))
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) { loadArrayBuffer(buf, SAMPLE_FILE); })
      .catch(function () {
        setUploadStatus(
          'Could not fetch the sample. If you opened this page as a local file, serve it over http instead (e.g. "python -m http.server") — browsers block fetch() on file:// pages.',
          'error'
        );
      });
  });

  function courseGroups(query) {
    var tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var groups = new Map();
    state.sections.forEach(function (sec) {
      if (tokens.length) {
        var hay = (sec.code + ' ' + sec.name + ' ' + sec.section).toLowerCase();
        var ok = tokens.every(function (t) { return hay.indexOf(t) !== -1; });
        if (!ok) return;
      }
      var gKey = sec.code + '|' + sec.name;
      var g = groups.get(gKey);
      if (!g) {
        g = { code: sec.code, name: sec.name, sections: [] };
        groups.set(gKey, g);
      }
      g.sections.push(sec);
    });
    return Array.from(groups.values());
  }

  function renderSearchResults() {
    searchResults.textContent = '';
    if (!state.sections.length) return;

    var groups = courseGroups(courseSearch.value);
    if (!groups.length) {
      searchResults.appendChild(el('div', 'no-results', 'No courses match that — try just the code, e.g. "EE3012".'));
      return;
    }

    groups.forEach(function (group) {
      var groupEl = el('div', 'result-group');
      var head = el('div', 'result-group-head', group.code + ' ');
      head.appendChild(el('span', 'rg-name', group.name));
      groupEl.appendChild(head);

      group.sections.forEach(function (sec) {
        var key = sectionKey(sec);
        var row = el('div', 'result-row');
        row.dataset.key = key;
        row.setAttribute('role', 'option');

        var main = el('div', 'result-row-main');
        main.appendChild(el('span', 'result-row-section', sec.section));
        var metaBits = [sec.teacher, sectionMeetingSummary(sec)].filter(Boolean);
        main.appendChild(el('span', 'result-row-meta', metaBits.join(' · ')));
        row.appendChild(main);

        var link = reviewLink(sec.teacher);
        if (link) row.appendChild(link);

        var addBtn = el('button', 'result-row-add', 'Add');
        addBtn.type = 'button';
        row.appendChild(addBtn);

        row.addEventListener('click', function () { toggleSection(sec); });
        groupEl.appendChild(row);
      });

      searchResults.appendChild(groupEl);
    });

    updateResultRowStates();
  }

  function updateResultRowStates() {
    searchResults.querySelectorAll('.result-row').forEach(function (row) {
      var added = state.selected.has(row.dataset.key);
      row.classList.toggle('added', added);
      row.setAttribute('aria-selected', added ? 'true' : 'false');
      row.querySelector('.result-row-add').textContent = added ? 'Added' : 'Add';
    });
  }

  courseSearch.addEventListener('input', renderSearchResults);

  function toggleSection(sec) {
    var key = sectionKey(sec);
    if (state.selected.has(key)) {
      state.selected.delete(key);
    } else {
      state.selected.set(key, sec);
      colorForSection(sec);
    }
    renderAll();
  }

  function renderSelectedList() {
    selectedList.textContent = '';
    state.selected.forEach(function (sec) {
      var li = el('li', 'selected-item');

      var swatch = el('span', 'selected-swatch');
      swatch.style.background = colorForSection(sec);
      li.appendChild(swatch);

      var main = el('div', 'selected-main');
      main.appendChild(el('div', 'selected-title', sec.code + ' · ' + sec.section));
      var metaBits = [sec.name, sec.teacher, sectionMeetingSummary(sec)].filter(Boolean);
      main.appendChild(el('div', 'selected-meta', metaBits.join(' · ')));
      li.appendChild(main);

      var link = reviewLink(sec.teacher);
      if (link) li.appendChild(link);

      var removeBtn = el('button', 'selected-remove', '×');
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', 'Remove ' + sec.code + ' ' + sec.section);
      removeBtn.addEventListener('click', function () { toggleSection(sec); });
      li.appendChild(removeBtn);

      selectedList.appendChild(li);
    });

    selectedCount.textContent = state.selected.size;
    emptySelectedHint.hidden = state.selected.size > 0;
    downloadBtn.disabled = state.selected.size === 0;
  }

  function resolveQuickAddToken(token) {
    var codeMatch = /[A-Za-z]{2,}\d{3,}/.exec(token);
    if (!codeMatch) return { ok: false, reason: 'no course code found' };

    var codeUpper = codeMatch[0].toUpperCase();
    var ofCode = state.sections.filter(function (s) { return s.code.toUpperCase() === codeUpper; });
    if (!ofCode.length) return { ok: false, reason: 'unknown code "' + codeMatch[0] + '"' };

    var remainder = (token.slice(0, codeMatch.index) + token.slice(codeMatch.index + codeMatch[0].length))
      .replace(/[^A-Za-z0-9]+/g, '').toLowerCase();

    if (!remainder) {
      if (ofCode.length === 1) return { ok: true, section: ofCode[0] };
      return { ok: false, reason: codeUpper + ' has ' + ofCode.length + ' sections — add one, e.g. ' + codeUpper + '-' + ofCode[0].section };
    }

    var norm = function (s) { return s.replace(/[^A-Za-z0-9]+/g, '').toLowerCase(); };
    var match =
      ofCode.find(function (s) { return norm(s.section) === remainder; }) ||
      ofCode.find(function (s) { return norm(s.section).slice(-remainder.length) === remainder; }) ||
      ofCode.find(function (s) { return norm(s.section).indexOf(remainder) !== -1; });

    if (!match) return { ok: false, reason: 'no section of ' + codeUpper + ' matches "' + remainder + '"' };
    return { ok: true, section: match };
  }

  quickAddResolve.addEventListener('click', function () {
    quickAddFeedback.textContent = '';
    var tokens = quickAddInput.value.split(/[\n,;]+/)
      .map(function (t) { return t.trim(); })
      .filter(Boolean);

    if (!tokens.length) {
      quickAddFeedback.appendChild(el('div', 'qa-fail', 'Nothing to add — paste codes like "EE3012-5A" first.'));
      return;
    }

    var changed = false;
    tokens.forEach(function (token) {
      var result = resolveQuickAddToken(token);
      if (!result.ok) {
        quickAddFeedback.appendChild(el('div', 'qa-fail', '✗ ' + token + ' — ' + result.reason));
        return;
      }
      var sec = result.section;
      var label = sec.code + ' ' + sec.section;
      if (state.selected.has(sectionKey(sec))) {
        quickAddFeedback.appendChild(el('div', 'qa-ok', '✓ ' + token + ' → ' + label + ' (already added)'));
      } else {
        state.selected.set(sectionKey(sec), sec);
        colorForSection(sec);
        changed = true;
        quickAddFeedback.appendChild(el('div', 'qa-ok', '✓ ' + token + ' → ' + label + ' added'));
      }
    });
    if (changed) renderAll();
  });

  function selectedEvents() {

    var events = [];
    state.selected.forEach(function (sec) {
      sec.meetings.forEach(function (meeting) {
        var start = meeting.startMin;
        events.push({
          sec: sec,
          meeting: meeting,
          dayIdx: meeting.dayIdx,
          start: start,
          end: start + meetingDuration(sec, meeting),
          isLab: meetingIsLab(sec, meeting)
        });
      });
    });
    return events;
  }

  function findConflicts(events) {
    var conflicts = [];
    for (var i = 0; i < events.length; i++) {
      for (var j = i + 1; j < events.length; j++) {
        var a = events[i], b = events[j];
        if (a.dayIdx !== b.dayIdx) continue;
        if (a.sec === b.sec) continue;
        if (a.start < b.end && b.start < a.end) conflicts.push([a, b]);
      }
    }
    return conflicts;
  }

  function renderConflicts(events) {
    var conflicts = findConflicts(events);
    conflictBanner.hidden = conflicts.length === 0;
    if (!conflicts.length) return;

    conflictText.textContent = '';
    conflictText.appendChild(el('div', null,
      conflicts.length === 1 ? 'These two classes overlap:' : 'Some of your classes overlap:'));
    var list = el('ul');
    conflicts.forEach(function (pair) {
      var a = pair[0], b = pair[1];
      list.appendChild(el('li', null,
        WEEKDAYS[a.dayIdx] + ': ' +
        a.sec.code + ' (' + a.sec.section + ') ' + fmtMinutes(a.start) + '–' + fmtMinutes(a.end) +
        ' ↔ ' +
        b.sec.code + ' (' + b.sec.section + ') ' + fmtMinutes(b.start) + '–' + fmtMinutes(b.end)));
    });
    conflictText.appendChild(list);
  }

  var LAYOUT = {
    pad: 18,
    gutterW: 56,
    headerH: 36,
    hourH: 64,
    colW: 164,
    titleH: 26
  };

  function computeGrid(events) {
    var dayIdxs = [0, 1, 2, 3, 4];
    if (events.some(function (ev) { return ev.dayIdx === 5; })) dayIdxs.push(5);

    var startHour = 8, endHour = 18;
    if (events.length) {
      var minStart = Math.min.apply(null, events.map(function (ev) { return ev.start; }));
      var maxEnd = Math.max.apply(null, events.map(function (ev) { return ev.end; }));
      startHour = Math.min(Math.floor(minStart / 60), 8);
      endHour = Math.max(Math.ceil(maxEnd / 60), 18);
    }
    return { dayIdxs: dayIdxs, startHour: startHour, endHour: endHour };
  }

  function assignOverlapSlices(dayEvents) {
    dayEvents.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); });
    var clusters = [];
    var current = null, currentMaxEnd = -1;
    dayEvents.forEach(function (ev) {
      if (!current || ev.start >= currentMaxEnd) {
        current = [];
        clusters.push(current);
        currentMaxEnd = ev.end;
      } else {
        currentMaxEnd = Math.max(currentMaxEnd, ev.end);
      }
      current.push(ev);
    });

    clusters.forEach(function (cluster) {
      var columnEnds = [];
      cluster.forEach(function (ev) {
        var placed = false;
        for (var c = 0; c < columnEnds.length; c++) {
          if (ev.start >= columnEnds[c]) {
            ev._slice = c;
            columnEnds[c] = ev.end;
            placed = true;
            break;
          }
        }
        if (!placed) {
          ev._slice = columnEnds.length;
          columnEnds.push(ev.end);
        }
      });
      cluster.forEach(function (ev) { ev._sliceCount = columnEnds.length; });
    });
  }

  function ellipsize(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    var s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) {
      s = s.slice(0, -1);
    }
    return s + '…';
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function renderTimetable(ctx, scale) {
    var events = selectedEvents();
    var grid = computeGrid(events);
    var L = LAYOUT;

    var titleParts = [];
    if (state.meta) {
      if (state.meta.department) titleParts.push(state.meta.department);
      if (state.meta.semester) titleParts.push(state.meta.semester);
    }
    var title = titleParts.join(' — ');
    var titleH = title ? L.titleH : 0;

    var gridW = grid.dayIdxs.length * L.colW;
    var gridH = (grid.endHour - grid.startHour) * L.hourH;
    var width = L.pad + L.gutterW + gridW + L.pad;
    var height = L.pad + titleH + L.headerH + gridH + L.pad;

    ctx.canvas.width = Math.round(width * scale);
    ctx.canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, width, height);

    var gx = L.pad + L.gutterW;
    var gy = L.pad + titleH + L.headerH;

    if (title) {
      ctx.fillStyle = CANVAS_INK;
      ctx.font = '600 13px ' + FONT_STACK;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(title, L.pad, L.pad + 14);
    }

    ctx.fillStyle = CANVAS_INK;
    ctx.font = '700 13px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    grid.dayIdxs.forEach(function (dayIdx, i) {
      ctx.fillText(WEEKDAYS[dayIdx], gx + i * L.colW + L.colW / 2, gy - L.headerH / 2);
    });

    for (var hour = grid.startHour; hour <= grid.endHour; hour++) {
      var y = gy + (hour - grid.startHour) * L.hourH;
      ctx.strokeStyle = CANVAS_GRIDLINE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(gx, y + 0.5);
      ctx.lineTo(gx + gridW, y + 0.5);
      ctx.stroke();

      ctx.fillStyle = CANVAS_MUTED;
      ctx.font = '11px ' + FONT_STACK;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmtHourLabel(hour), gx - 8, y);

      if (hour < grid.endHour) {
        ctx.save();
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(gx, y + L.hourH / 2 + 0.5);
        ctx.lineTo(gx + gridW, y + L.hourH / 2 + 0.5);
        ctx.stroke();
        ctx.restore();
      }
    }

    ctx.strokeStyle = CANVAS_GRIDLINE;
    for (var d = 0; d <= grid.dayIdxs.length; d++) {
      var x = gx + d * L.colW;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, gy);
      ctx.lineTo(x + 0.5, gy + gridH);
      ctx.stroke();
    }

    if (!events.length) {
      ctx.fillStyle = CANVAS_MUTED;
      ctx.font = '13px ' + FONT_STACK;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Add sections in step 2 to see your schedule here.', gx + gridW / 2, gy + gridH / 2);
      return;
    }

    grid.dayIdxs.forEach(function (dayIdx, colIdx) {
      var dayEvents = events.filter(function (ev) { return ev.dayIdx === dayIdx; });
      if (!dayEvents.length) return;
      assignOverlapSlices(dayEvents);

      dayEvents.forEach(function (ev) {
        var sliceW = (L.colW - 4) / ev._sliceCount;
        var x = gx + colIdx * L.colW + 2 + ev._slice * sliceW + 1;
        var w = sliceW - 2;
        var y = gy + (ev.start - grid.startHour * 60) / 60 * L.hourH + 1;
        var h = (ev.end - ev.start) / 60 * L.hourH - 2;

        var fill = colorForSection(ev.sec);
        roundRectPath(ctx, x, y, w, h, 6);
        ctx.fillStyle = fill;
        ctx.fill();

        ctx.save();
        roundRectPath(ctx, x, y, w, h, 6);
        ctx.clip();
        ctx.fillStyle = labelColorOn(fill);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        var innerX = x + 8;
        var innerW = w - 16;
        var cursorY = y + 7;
        var lines = [
          { text: ev.sec.code + ' · ' + ev.sec.section, font: '700 12px ' + FONT_STACK, lh: 15 },
          { text: ev.meeting.room, font: '11px ' + FONT_STACK, lh: 14 },
          { text: ev.sec.teacher, font: '11px ' + FONT_STACK, lh: 14 },
          { text: ev.sec.name, font: 'italic 10.5px ' + FONT_STACK, lh: 13 },
          { text: fmtMinutes(ev.start) + '–' + fmtMinutes(ev.end), font: '10.5px ' + FONT_STACK, lh: 13 }
        ];
        lines.forEach(function (line) {
          if (!line.text) return;
          if (cursorY + line.lh > y + h - 4) return;
          ctx.font = line.font;
          ctx.fillText(ellipsize(ctx, line.text, innerW), innerX, cursorY + line.lh - 3);
          cursorY += line.lh;
        });
        ctx.restore();
      });
    });
  }

  function renderCanvas() {
    if (!state.sections.length) return;
    var scale = Math.min(window.devicePixelRatio || 1, 2) * 1.25;
    var ctx = canvas.getContext('2d');
    renderTimetable(ctx, scale);

  }

  downloadBtn.addEventListener('click', function () {
    var exportCanvas = document.createElement('canvas');
    var ctx = exportCanvas.getContext('2d');
    renderTimetable(ctx, 3);

    exportCanvas.toBlob(function (blob) {
      if (!blob) return;
      var firstSec = state.selected.values().next().value;
      var name = firstSec
        ? 'timetable-' + firstSec.code.toLowerCase() + '.png'
        : 'my-timetable.png';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }, 'image/png');
  });

  function jumpToSearch(code) {
    courseSearch.value = code;
    renderSearchResults();
    buildPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    courseSearch.focus({ preventScroll: true });
  }

  function matchesFilter(hay, tokens) {
    if (!tokens.length) return true;
    hay = hay.toLowerCase();
    return tokens.every(function (t) { return hay.indexOf(t) !== -1; });
  }

  function teacherCatalog() {

    var byTeacher = new Map();
    state.sections.forEach(function (sec) {
      var name = sec.teacher || 'TBA';
      var entry = byTeacher.get(name);
      if (!entry) {
        entry = { name: name, courses: new Map(), sectionCount: 0 };
        byTeacher.set(name, entry);
      }
      entry.sectionCount++;
      var cKey = sec.code + '|' + sec.name;
      var course = entry.courses.get(cKey);
      if (!course) {
        course = { code: sec.code, name: sec.name, sectionCount: 0 };
        entry.courses.set(cKey, course);
      }
      course.sectionCount++;
    });
    var teachers = Array.from(byTeacher.values());
    teachers.sort(function (a, b) {
      if (a.name === 'TBA') return 1;
      if (b.name === 'TBA') return -1;
      return a.name.localeCompare(b.name);
    });
    return teachers;
  }

  function teacherInitials(name) {
    var words = name.split(/\s+/).filter(Boolean);
    var initials = words.slice(0, 2).map(function (w) { return w.charAt(0); }).join('');
    return initials.toUpperCase() || '?';
  }

  function renderBrowseStats() {
    browseStats.textContent = '';
    var courseCount = courseGroups('').length;
    var teacherCount = teacherCatalog().filter(function (t) { return t.name !== 'TBA'; }).length;
    var stats = [
      [courseCount, courseCount === 1 ? 'course' : 'courses'],
      [teacherCount, teacherCount === 1 ? 'teacher' : 'teachers'],
      [state.sections.length, state.sections.length === 1 ? 'section' : 'sections']
    ];
    stats.forEach(function (s) {
      var chip = el('span', 'stat-chip');
      chip.appendChild(el('strong', null, String(s[0])));
      chip.appendChild(document.createTextNode(s[1]));
      browseStats.appendChild(chip);
    });
  }

  function renderBrowseCourses(tokens) {
    var grid = el('div', 'course-grid');
    var shown = 0;
    courseGroups('').forEach(function (group) {
      var teachers = [];
      group.sections.forEach(function (sec) {
        if (sec.teacher && teachers.indexOf(sec.teacher) === -1) teachers.push(sec.teacher);
      });
      var hay = group.code + ' ' + group.name + ' ' + teachers.join(' ');
      if (!matchesFilter(hay, tokens)) return;
      shown++;

      var card = el('button', 'course-card');
      card.type = 'button';

      var top = el('div', 'course-card-top');
      top.appendChild(el('span', 'course-code', group.code));
      if (/\blab\b/i.test(group.name)) top.appendChild(el('span', 'lab-tag', 'Lab'));
      card.appendChild(top);

      card.appendChild(el('div', 'course-name', group.name));

      var n = group.sections.length;
      var meta = n + (n === 1 ? ' section' : ' sections');
      if (teachers.length) meta += ' · ' + teachers.join(', ');
      card.appendChild(el('div', 'course-meta', meta));

      card.addEventListener('click', function () { jumpToSearch(group.code); });
      grid.appendChild(card);
    });

    if (!shown) {
      browseContent.appendChild(el('div', 'no-results', 'Nothing in the catalog matches that filter.'));
    } else {
      browseContent.appendChild(grid);
    }
  }

  function renderBrowseTeachers(tokens) {
    var list = el('div', 'teacher-list');
    var shown = 0;
    teacherCatalog().forEach(function (teacher) {
      var courses = Array.from(teacher.courses.values());
      var hay = teacher.name + ' ' + courses.map(function (c) { return c.code + ' ' + c.name; }).join(' ');
      if (!matchesFilter(hay, tokens)) return;
      shown++;

      var row = el('div', 'teacher-row');

      var head = el('div', 'teacher-head');
      head.appendChild(el('span', 'teacher-avatar', teacherInitials(teacher.name)));
      head.appendChild(el('span', 'teacher-name', teacher.name));
      var nc = courses.length;
      head.appendChild(el('span', 'teacher-load',
        nc + (nc === 1 ? ' course' : ' courses') + ' · ' +
        teacher.sectionCount + (teacher.sectionCount === 1 ? ' section' : ' sections')));
      var link = reviewLink(teacher.name);
      if (link) head.appendChild(link);
      row.appendChild(head);

      var chips = el('div', 'teacher-courses');
      courses.forEach(function (course) {
        var chip = el('button', 'course-chip');
        chip.type = 'button';
        chip.appendChild(el('strong', null, course.code));
        chip.appendChild(document.createTextNode(' ' + course.name));
        chip.title = course.code + ' — ' + course.name;
        chip.addEventListener('click', function () { jumpToSearch(course.code); });
        chips.appendChild(chip);
      });
      row.appendChild(chips);

      list.appendChild(row);
    });

    if (!shown) {
      browseContent.appendChild(el('div', 'no-results', 'No teacher matches that filter.'));
    } else {
      browseContent.appendChild(list);
    }
  }

  function renderBrowse() {
    if (!state.sections.length) return;
    renderBrowseStats();
    browseContent.textContent = '';
    var tokens = browseFilter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (state.browseView === 'teachers') renderBrowseTeachers(tokens);
    else renderBrowseCourses(tokens);
  }

  function setBrowseView(view) {
    state.browseView = view;
    tabCourses.classList.toggle('active', view === 'courses');
    tabTeachers.classList.toggle('active', view === 'teachers');
    tabCourses.setAttribute('aria-selected', view === 'courses' ? 'true' : 'false');
    tabTeachers.setAttribute('aria-selected', view === 'teachers' ? 'true' : 'false');
    renderBrowse();
  }

  tabCourses.addEventListener('click', function () { setBrowseView('courses'); });
  tabTeachers.addEventListener('click', function () { setBrowseView('teachers'); });
  browseFilter.addEventListener('input', renderBrowse);

  campusSelect.value = state.reviewCampus;
  campusSelect.addEventListener('change', function () {
    state.reviewCampus = campusSelect.value;
    try {
      window.localStorage.setItem(CAMPUS_STORAGE_KEY, state.reviewCampus);
    } catch (e) {}

    renderSearchResults();
    renderSelectedList();
    renderBrowse();
  });

  function renderAll() {
    renderSelectedList();
    updateResultRowStates();
    renderConflicts(selectedEvents());
    renderCanvas();
  }

  theoryMinInput.addEventListener('input', renderAll);
  labMinInput.addEventListener('input', renderAll);
})();
