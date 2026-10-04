// rooms/index.html: the Free Room Finder. Ported from the standalone
// free-room-finder repo. That version fetched bundled xlsx files and parsed them
// in the browser; this one reads every timetable published in the Timetable
// Decoder from /api/rooms/data (the server parses each upload once, see
// server/parser/). The data needs a Room Finder session, which is separate from
// the timetable tool's login (server/rooms/auth.js).

import { WEEKDAYS, fmtMinutes } from '../../../server/parser/time.js';
import {
  FREE_SLOT_CUTOFF, TEACHING_DAYS, buildFreeSlots, clock24, daysForScope, formatText, teachingWindow
} from '../free-slots.js';
import { renderFreeSlotsPng } from '../free-png.js';
import { LOGIN_PATH, changePassword, loadRoomData, requireAccount, signOut } from '../client.js';

(function () {
  var $ = function (id) { return document.getElementById(id); };

  var uploadStatus = $('upload-status');
  var fileList = $('file-list');
  var coverage = $('coverage');
  var covRooms = $('cov-rooms');
  var covClasses = $('cov-classes');
  var covFiles = $('cov-files');
  var covNote = $('cov-note');
  var estimatesBox = $('estimates-box');
  var theoryMinInput = $('theory-min');
  var labMinInput = $('lab-min');

  var filterPanel = $('filter-panel');
  var roomSearch = $('room-search');
  var kindRow = $('kind-row');
  var buildingField = $('building-field');
  var buildingRow = $('building-row');
  var floorField = $('floor-field');
  var floorRow = $('floor-row');
  var deptField = $('dept-field');
  var deptRow = $('dept-row');
  var groupRow = $('group-row');
  var showBusy = $('show-busy');
  var showLate = $('show-late');

  var resultPanel = $('result-panel');
  var tabNow = $('tab-now');
  var tabSlot = $('tab-slot');
  var queryNow = $('query-now');
  var querySlot = $('query-slot');
  var nowClock = $('now-clock');
  var nowRefresh = $('now-refresh');
  var nowOverride = $('now-override');
  var nowOverrideGrid = $('now-override-grid');
  var nowDay = $('now-day');
  var nowTime = $('now-time');
  var minfreeRow = $('minfree-row');
  var slotDay = $('slot-day');
  var slotStart = $('slot-start');
  var slotDur = $('slot-dur');
  var durRow = $('dur-row');
  var slotEcho = $('slot-echo');
  var resultSummary = $('result-summary');
  var freeList = $('free-list');
  var freeEmpty = $('free-empty');
  var busyBlock = $('busy-block');
  var busyCount = $('busy-count');
  var busyList = $('busy-list');

  var clashOpen = $('clash-open');
  var clashCount = $('clash-count');
  var clashModal = $('clash-modal');
  var clashClose = $('clash-close');
  var clashListEl = $('clash-list');
  var roomModal = $('room-modal');
  var roomModalTitle = $('room-modal-title');
  var roomModalBody = $('room-modal-body');
  var roomClose = $('room-close');

  var exportOpen = $('export-open');
  var exportModal = $('export-modal');
  var exportClose = $('export-close');
  var exportRoom = $('export-room');
  var exportRoomList = $('export-room-list');
  var exportScope = $('export-scope');
  var exportDayField = $('export-day-field');
  var exportDay = $('export-day');
  var exportDaysField = $('export-days-field');
  var exportDays = $('export-days');
  var exportFrom = $('export-from');
  var exportTo = $('export-to');
  var exportGap = $('export-gap');
  var exportStatus = $('export-status');
  var exportPreview = $('export-preview');
  var exportCopy = $('export-copy');
  var exportPng = $('export-png');
  var exportCopyImage = $('export-copy-image');
  var exportImage = $('export-image');

  var accountBar = $('account-bar');
  var accountName = $('account-name');
  var signoutBtn = $('signout-btn');
  var passwordOpen = $('password-open');
  var passwordModal = $('password-modal');
  var passwordClose = $('password-close');
  var passwordForm = $('password-form');
  var pwCurrent = $('pw-current');
  var pwNew = $('pw-new');
  var pwConfirm = $('pw-confirm');
  var passwordStatus = $('password-status');
  var passwordSubmit = $('password-submit');

  var state = {
    files: [],
    nextFileId: 1,
    rooms: [],
    roomByKey: new Map(),
    clashes: [],
    mode: 'now',
    kind: 'all',
    building: 'all',
    floor: 'all',
    dept: 'all',
    groupBy: 'building',
    minFree: 0,
    query: '',
    lastFocus: null,
    exportScope: 'day',
    exportDaySet: new Set(),
    exportReport: null
  };

  var DAY_END = 22 * 60;
  var DAY_START = 7 * 60;
  // Rooms are closed after this; the "show late times" tick box lifts the cut-off.
  var CLOSE_AT = 17 * 60 + 30;

  var MIN_PASSWORD = 8;

  // A block is not bookable for these searches, so its rooms never surface.
  var HIDDEN_BUILDINGS = ['BLK-A'];

  /* ---------------------------------------------------------------- rooms */

  // "D - 6", "d-6" and "D  6" are the same room typed three ways; fold them
  // onto one key but keep the most common spelling for display.
  function roomKeyOf(raw) {
    return String(raw)
      .toUpperCase()
      .replace(/^\s*(ROOM|RM)[\s.:-]+/, '')
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function roomIsLab(label) {
    return /\blab\b|laborator/i.test(label);
  }

  var ORDINAL = ['Ground', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
  var ROMAN = { i: 1, v: 5, x: 10 };

  function romanToInt(raw) {
    var t = String(raw).toLowerCase(), total = 0, prev = 0;
    for (var i = t.length - 1; i >= 0; i--) {
      var v = ROMAN[t.charAt(i)];
      if (!v) return null;
      total += v < prev ? -v : v;
      if (v >= prev) prev = v;
    }
    return total || null;
  }

  function titleCase(text) {
    return String(text).replace(/\S+/g, function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
  }

  // A room name carries its own geography: "F-310" is the 3rd floor of F block,
  // "Eng Lab-2" belongs to the engineering lab cluster, "Auditorium" to neither.
  // Split the label into a building and a floor so rooms can be filtered and
  // grouped by where they are. Both are inferred from the name - the timetables
  // never say which building a room sits in.
  function classifyRoom(label) {
    var s = String(label).replace(/\s+/g, ' ').trim();
    var m = /^(?:room\s+)?([A-Za-z][A-Za-z.&' ]*?)\s*[-\u2013\u2014.]?\s*(\d{1,4}|[ivx]{1,6})\s*[a-z]?$/i.exec(s);
    var prefix = m ? m[1].replace(/[.\s]+$/, '').trim() : s;
    var num = m ? (/^\d+$/.test(m[2]) ? parseInt(m[2], 10) : romanToInt(m[2])) : null;
    if (m && num === null) { m = null; prefix = s; }

    var building, buildingLabel, rank;
    if (m && /^[A-Za-z]$/.test(prefix)) {
      building = 'BLK-' + prefix.toUpperCase();
      buildingLabel = prefix.toUpperCase() + ' Block';
      rank = 1;
    } else if (m && /\blabs?\b|laborator/i.test(prefix)) {
      var family = titleCase(prefix.replace(/\s*laborator(y|ies)$/i, '').replace(/\s*labs?$/i, '').trim());
      building = 'LAB-' + (family.toUpperCase() || 'GENERAL');
      buildingLabel = family ? family + ' Labs' : 'Labs';
      rank = 2;
    } else if (/\blabs?\b|laborator/i.test(s)) {
      building = 'LAB-NAMED';
      buildingLabel = 'Named labs';
      rank = 3;
    } else if (/\bhalls?\b|auditorium|theatre|theater|gym/i.test(s)) {
      building = 'HALL';
      buildingLabel = 'Halls & auditoriums';
      rank = 4;
    } else if (m) {
      building = 'BLK-' + prefix.toUpperCase();
      buildingLabel = titleCase(prefix) + ' Block';
      rank = 1;
    } else {
      building = 'OTHER';
      buildingLabel = 'Other spaces';
      rank = 5;
    }

    var floor, floorLabel, floorRank;
    if (num !== null && num >= 100) {
      floorRank = Math.floor(num / 100);
      floor = 'FL-' + floorRank;
      floorLabel = (ORDINAL[floorRank] || floorRank + 'th') + ' floor';
    } else if (num !== null) {
      floorRank = 0;
      floor = 'FL-0';
      floorLabel = 'Ground floor';
    } else {
      floorRank = 99;
      floor = 'FL-NA';
      floorLabel = 'Unnumbered';
    }

    return {
      building: building,
      buildingLabel: buildingLabel,
      buildingRank: rank,
      floor: floor,
      floorLabel: floorLabel,
      floorRank: floorRank,
      number: num
    };
  }

  function estimatesFromInputs() {
    var t = parseInt(theoryMinInput.value, 10);
    var l = parseInt(labMinInput.value, 10);
    return {
      theoryMin: isFinite(t) && t > 0 ? t : 80,
      labMin: isFinite(l) && l > 0 ? l : 150
    };
  }

  // One booking per meeting, per file. Rebuilt whenever the estimates change,
  // since estimated durations feed straight into "is this room busy".
  function rebuildIndex() {
    var est = estimatesFromInputs();

    var byKey = new Map();

    state.files.forEach(function (file) {
      file.sections.forEach(function (sec) {
        sec.meetings.forEach(function (m) {
          var rawRoom = String(m.room || '').trim();
          if (!rawRoom) return;
          var key = roomKeyOf(rawRoom);
          if (!key) return;

          var room = byKey.get(key);
          if (!room) {
            room = {
              key: key, label: rawRoom, labelCounts: new Map(),
              bookings: [], files: new Set(), depts: new Set()
            };
            byKey.set(key, room);
          }
          room.labelCounts.set(rawRoom, (room.labelCounts.get(rawRoom) || 0) + 1);
          room.files.add(file.id);
          room.depts.add(file.department);

          // The server stores the file's own length when it states one, and
          // flags labs (course name or room says "lab") for the estimate.
          var dur = m.durMin || (m.isLab ? est.labMin : est.theoryMin);
          room.bookings.push({
            dayIdx: m.dayIdx,
            startMin: m.startMin,
            endMin: m.startMin + dur,
            code: sec.code,
            name: sec.name,
            section: sec.section,
            teacher: sec.teacher,
            fileId: file.id,
            fileLabel: file.label,
            estimated: !m.durMin
          });
        });
      });
    });

    var rooms = Array.from(byKey.values());
    rooms.forEach(function (room) {
      var best = '', bestN = -1;
      room.labelCounts.forEach(function (n, label) {
        if (n > bestN || (n === bestN && label.length < best.length)) { best = label; bestN = n; }
      });
      room.label = best;
      room.isLab = roomIsLab(best) || room.bookings.every(function (b) { return /lab/i.test(b.name); });
      var where = classifyRoom(best);
      room.building = where.building;
      room.buildingLabel = where.buildingLabel;
      room.buildingRank = where.buildingRank;
      room.floor = where.floor;
      room.floorLabel = where.floorLabel;
      room.floorRank = where.floorRank;
      room.whereLabel = where.floor === 'FL-NA'
        ? where.buildingLabel
        : where.buildingLabel + ' · ' + where.floorLabel;
      room.bookings.sort(function (a, b) {
        return (a.dayIdx - b.dayIdx) || (a.startMin - b.startMin) || (a.endMin - b.endMin);
      });
    });
    rooms = rooms.filter(function (room) {
      if (HIDDEN_BUILDINGS.indexOf(room.building) === -1) return true;
      byKey.delete(room.key);
      return false;
    });

    rooms.sort(function (a, b) {
      return (a.buildingRank - b.buildingRank) ||
        a.buildingLabel.localeCompare(b.buildingLabel) ||
        (a.floorRank - b.floorRank) ||
        a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
    });

    state.rooms = rooms;
    state.roomByKey = byKey;
    state.clashes = findClashes(rooms);
  }

  function sameClass(a, b) {
    return a.code === b.code && a.section === b.section;
  }

  function findClashes(rooms) {
    var out = [];
    rooms.forEach(function (room) {
      for (var i = 0; i < room.bookings.length; i++) {
        for (var j = i + 1; j < room.bookings.length; j++) {
          var a = room.bookings[i], b = room.bookings[j];
          if (a.dayIdx !== b.dayIdx) break;
          if (b.startMin >= a.endMin) break;
          if (sameClass(a, b)) continue;
          out.push({ room: room, a: a, b: b });
        }
      }
    });
    return out;
  }

  /* -------------------------------------------------------------- queries */

  function bookingsOn(room, dayIdx) {
    return room.bookings.filter(function (b) { return b.dayIdx === dayIdx; });
  }

  function busyAt(room, dayIdx, minute) {
    var hits = bookingsOn(room, dayIdx).filter(function (b) {
      return b.startMin <= minute && minute < b.endMin;
    });
    return hits.length ? hits : null;
  }

  // How long this room stays free from `minute` on - capped at the end of the
  // teaching day so "free forever" reads as a number, not Infinity.
  function dayEnd() {
    return showLate.checked ? DAY_END : CLOSE_AT;
  }

  function freeUntil(room, dayIdx, minute) {
    var next = null, limit = dayEnd();
    bookingsOn(room, dayIdx).forEach(function (b) {
      if (b.startMin >= minute && b.startMin < limit && (next === null || b.startMin < next.startMin)) next = b;
    });
    if (!next) return { until: null, minutes: Math.max(0, limit - minute), nextClass: null };
    return { until: next.startMin, minutes: next.startMin - minute, nextClass: next };
  }

  function freeForWindow(room, dayIdx, startMin, endMin) {
    return !bookingsOn(room, dayIdx).some(function (b) {
      return b.startMin < endMin && startMin < b.endMin;
    });
  }

  function freesAt(room, dayIdx, minute) {
    // Walk forward through back-to-back classes so "free at" is the real gap,
    // not just the end of the class sitting on top of you.
    var day = bookingsOn(room, dayIdx);
    var cursor = minute;
    var moved = true;
    while (moved) {
      moved = false;
      for (var i = 0; i < day.length; i++) {
        if (day[i].startMin <= cursor && cursor < day[i].endMin) {
          cursor = day[i].endMin;
          moved = true;
        }
      }
    }
    return cursor;
  }

  /* --------------------------------------------------------------- filter */

  function matchesFilters(room) {
    if (state.kind === 'lab' && !room.isLab) return false;
    if (state.kind === 'class' && room.isLab) return false;
    if (state.building !== 'all' && room.building !== state.building) return false;
    if (state.floor !== 'all' && room.floor !== state.floor) return false;
    if (state.dept !== 'all' && !room.depts.has(state.dept)) return false;
    if (state.query) {
      var hay = (room.label + ' ' + room.key + ' ' + room.whereLabel + ' ' +
        Array.from(room.depts).join(' ')).toLowerCase();
      var ok = state.query.split(/\s+/).every(function (t) { return !t || hay.indexOf(t) !== -1; });
      if (!ok) return false;
    }
    return true;
  }

  function visibleRooms() {
    return state.rooms.filter(matchesFilters);
  }

  /* --------------------------------------------------------------- render */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmtSpan(minutes) {
    if (minutes >= 60) {
      var h = Math.floor(minutes / 60), m = minutes % 60;
      return m ? h + ' hr ' + m + ' min' : h + ' hr';
    }
    return minutes + ' min';
  }

  function roomCard(room, opts) {
    var card = el('button', 'room-card' + (opts.busy ? ' is-busy' : ' is-free'));
    card.type = 'button';
    card.setAttribute('data-room', room.key);

    var head = el('span', 'room-card-head');
    head.appendChild(el('span', 'room-name', room.label));
    var tag = el('span', 'room-tag', room.isLab ? 'Lab' : 'Class');
    head.appendChild(tag);
    card.appendChild(head);

    // The group heading already says where the room is; only repeat it on the
    // card when the list isn't grouped by place.
    if (state.groupBy !== 'building' && state.groupBy !== 'floor') {
      card.appendChild(el('span', 'room-where', room.whereLabel));
    }

    card.appendChild(el('span', 'room-line', opts.line));
    if (opts.sub) card.appendChild(el('span', 'room-sub', opts.sub));
    return card;
  }

  // Which bucket(s) a room belongs to under the current "group by". A room can
  // sit in several department buckets - two departments booking one room is the
  // whole reason this app merges files.
  function groupsOf(room) {
    if (state.groupBy === 'building') {
      return [{ key: room.building, label: room.buildingLabel, rank: [room.buildingRank, 0] }];
    }
    if (state.groupBy === 'floor') {
      return [{
        key: room.building + '|' + room.floor,
        label: room.whereLabel,
        rank: [room.buildingRank, room.floorRank]
      }];
    }
    if (state.groupBy === 'dept') {
      return Array.from(room.depts).sort().map(function (d) {
        return { key: 'D-' + d, label: d, rank: [0, 0] };
      });
    }
    return [];
  }

  function paintCards(container, entries, busy) {
    var gridClass = 'room-grid' + (busy ? ' busy-grid' : '');
    container.textContent = '';

    if (state.groupBy === 'none' || !entries.length) {
      container.className = gridClass;
      entries.forEach(function (e) { container.appendChild(roomCard(e.room, e.opts)); });
      return;
    }

    container.className = 'room-groups';
    var order = [];
    var byKey = new Map();
    entries.forEach(function (e) {
      groupsOf(e.room).forEach(function (g) {
        var slot = byKey.get(g.key);
        if (!slot) {
          slot = { label: g.label, rank: g.rank, items: [] };
          byKey.set(g.key, slot);
          order.push(slot);
        }
        slot.items.push(e);
      });
    });
    order.sort(function (a, b) {
      return (a.rank[0] - b.rank[0]) || (a.rank[1] - b.rank[1]) || a.label.localeCompare(b.label);
    });

    order.forEach(function (group) {
      var section = el('section', 'room-group');
      var head = el('h4', 'group-head');
      head.appendChild(el('span', 'group-name', group.label));
      head.appendChild(el('span', 'pill', String(group.items.length)));
      section.appendChild(head);
      var grid = el('div', gridClass);
      group.items.forEach(function (e) { grid.appendChild(roomCard(e.room, e.opts)); });
      section.appendChild(grid);
      container.appendChild(section);
    });
  }

  function isClosedAt(minute) {
    return !showLate.checked && minute >= CLOSE_AT;
  }

  function renderClosed(dayIdx, minute) {
    freeList.textContent = '';
    renderBusy([]);
    resultSummary.textContent = 'Closed on ' + WEEKDAYS[dayIdx] + ' at ' + fmtMinutes(minute) +
      ' - rooms close at ' + fmtMinutes(CLOSE_AT) + '.';
    freeEmpty.textContent = 'Classes are closed after ' + fmtMinutes(CLOSE_AT) +
      '. Tick "Show times after ' + fmtMinutes(CLOSE_AT) + '" to see room availability for later times anyway.';
    freeEmpty.hidden = false;
  }

  function renderNow() {
    var when = currentWhen();
    var dayIdx = when.dayIdx;
    var minute = when.minute;
    if (isClosedAt(minute)) return renderClosed(dayIdx, minute);

    var rooms = visibleRooms();
    var free = [], busy = [];

    rooms.forEach(function (room) {
      var hits = busyAt(room, dayIdx, minute);
      if (hits) {
        busy.push({ room: room, hits: hits, freeAt: freesAt(room, dayIdx, minute) });
      } else {
        var f = freeUntil(room, dayIdx, minute);
        if (f.minutes >= state.minFree) free.push({ room: room, f: f });
      }
    });

    free.sort(function (a, b) { return b.f.minutes - a.f.minutes || a.room.label.localeCompare(b.room.label, undefined, { numeric: true }); });
    busy.sort(function (a, b) { return a.freeAt - b.freeAt; });

    paintCards(freeList, free.map(function (item) {
      var f = item.f;
      var line = f.until === null
        ? 'Free for the rest of the day'
        : 'Free for ' + fmtSpan(f.minutes) + ' - until ' + fmtMinutes(f.until);
      var sub = f.nextClass
        ? 'Then ' + f.nextClass.code + ' (' + f.nextClass.section + ')'
        : 'Nothing else booked today';
      return { room: item.room, opts: { line: line, sub: sub, busy: false } };
    }), false);

    renderBusy(busy);

    var total = rooms.length;
    resultSummary.textContent = free.length + ' of ' + total + ' room' + (total === 1 ? '' : 's') +
      ' free on ' + WEEKDAYS[dayIdx] + ' at ' + fmtMinutes(minute) +
      (state.minFree ? ' for ' + fmtSpan(state.minFree) + ' or more' : '');
    freeEmpty.hidden = free.length > 0;
    if (!free.length) {
      freeEmpty.textContent = total
        ? 'Every room that matches your filters is occupied right then.'
        : 'No rooms match your filters.';
    }
  }

  function renderSlot() {
    var dayIdx = parseInt(slotDay.value, 10) || 0;
    var startMin = timeInputToMinutes(slotStart.value);
    var dur = parseInt(slotDur.value, 10);
    if (!isFinite(dur) || dur <= 0) dur = 60;
    if (startMin === null) startMin = 8 * 60 + 30;
    var endMin = startMin + dur;

    slotEcho.textContent = WEEKDAYS[dayIdx] + ', ' + fmtMinutes(startMin) + ' - ' + fmtMinutes(endMin) +
      ' (' + fmtSpan(dur) + ')';
    if (isClosedAt(startMin)) return renderClosed(dayIdx, startMin);

    var rooms = visibleRooms();
    var free = [], busy = [];

    rooms.forEach(function (room) {
      if (freeForWindow(room, dayIdx, startMin, endMin)) {
        var f = freeUntil(room, dayIdx, endMin);
        free.push({ room: room, extra: f.minutes, f: f });
      } else {
        var blockers = bookingsOn(room, dayIdx).filter(function (b) {
          return b.startMin < endMin && startMin < b.endMin;
        });
        busy.push({ room: room, hits: blockers, freeAt: freesAt(room, dayIdx, Math.max(startMin, blockers[0].startMin)) });
      }
    });

    free.sort(function (a, b) { return b.extra - a.extra || a.room.label.localeCompare(b.room.label, undefined, { numeric: true }); });
    busy.sort(function (a, b) { return a.freeAt - b.freeAt; });

    paintCards(freeList, free.map(function (item) {
      var line = 'Free ' + fmtMinutes(startMin) + ' - ' + fmtMinutes(endMin);
      var sub = item.extra > 0
        ? (item.f.until === null
            ? 'And clear for the rest of the day'
            : 'Clear for ' + fmtSpan(item.extra) + ' more after that')
        : 'Booked again right after';
      return { room: item.room, opts: { line: line, sub: sub, busy: false } };
    }), false);

    renderBusy(busy);

    resultSummary.textContent = free.length + ' of ' + rooms.length + ' room' + (rooms.length === 1 ? '' : 's') +
      ' free for the whole ' + fmtSpan(dur) + ' on ' + WEEKDAYS[dayIdx] + ' from ' + fmtMinutes(startMin) + '.';
    freeEmpty.hidden = free.length > 0;
    if (!free.length) {
      freeEmpty.textContent = rooms.length
        ? 'No room is free for that whole window. Try a shorter slot, a different time, or widen the filters.'
        : 'No rooms match your filters.';
    }
  }

  function renderBusy(busy) {
    busyBlock.hidden = !showBusy.checked || !busy.length;
    busyCount.textContent = busy.length;
    busyList.textContent = '';
    if (busyBlock.hidden) return;
    paintCards(busyList, busy.map(function (item) {
      var hit = item.hits[0];
      var line = hit.code + ' (' + hit.section + ')' + (hit.estimated ? ' *' : '');
      var sub = 'Frees at ' + fmtMinutes(item.freeAt) +
        (item.hits.length > 1 ? ' · ' + item.hits.length + ' classes booked' : '') +
        (hit.teacher ? ' · ' + hit.teacher : '');
      return { room: item.room, opts: { line: line, sub: sub, busy: true } };
    }), true);
  }

  function renderResults() {
    if (!state.rooms.length) return;
    if (state.mode === 'now') renderNow(); else renderSlot();
  }

  function fillChips(row, attr, current, options) {
    row.textContent = '';
    options.forEach(function (opt) {
      var b = el('button', 'chip' + (current === opt.value ? ' is-on' : ''), opt.label);
      b.type = 'button';
      b.setAttribute(attr, opt.value);
      if (opt.count !== undefined) {
        b.appendChild(el('span', 'chip-count', String(opt.count)));
      }
      row.appendChild(b);
    });
  }

  function tally(rooms, keyOf, labelOf, rankOf) {
    var order = [];
    var byKey = new Map();
    rooms.forEach(function (room) {
      [].concat(keyOf(room)).forEach(function (key) {
        var slot = byKey.get(key);
        if (!slot) {
          slot = { value: key, label: labelOf(room, key), rank: rankOf(room), count: 0 };
          byKey.set(key, slot);
          order.push(slot);
        }
        slot.count++;
      });
    });
    order.sort(function (a, b) {
      return (a.rank[0] - b.rank[0]) || (a.rank[1] - b.rank[1]) || a.label.localeCompare(b.label);
    });
    return order;
  }

  // Buildings list every room; floors only the ones inside the chosen building,
  // so the two rows read as one drill-down instead of two loose filters.
  function renderFacets() {
    var buildings = tally(state.rooms,
      function (r) { return r.building; },
      function (r) { return r.buildingLabel; },
      function (r) { return [r.buildingRank, 0]; });

    buildingField.hidden = buildings.length < 2;
    if (state.building !== 'all' && !buildings.some(function (b) { return b.value === state.building; })) {
      state.building = 'all';
    }
    fillChips(buildingRow, 'data-building', state.building,
      [{ value: 'all', label: 'All', count: state.rooms.length }].concat(buildings));

    var inBuilding = state.rooms.filter(function (r) {
      return state.building === 'all' || r.building === state.building;
    });
    var floors = tally(inBuilding,
      function (r) { return r.floor; },
      function (r) { return r.floorLabel; },
      function (r) { return [r.floorRank, 0]; });

    floorField.hidden = floors.length < 2;
    if (state.floor !== 'all' && !floors.some(function (f) { return f.value === state.floor; })) {
      state.floor = 'all';
    }
    fillChips(floorRow, 'data-floor', state.floor,
      [{ value: 'all', label: 'All', count: inBuilding.length }].concat(floors));

    var depts = tally(state.rooms,
      function (r) { return Array.from(r.depts); },
      function (r, key) { return key; },
      function () { return [0, 0]; });

    deptField.hidden = depts.length < 2;
    if (state.dept !== 'all' && !depts.some(function (d) { return d.value === state.dept; })) {
      state.dept = 'all';
    }
    fillChips(deptRow, 'data-dept', state.dept,
      [{ value: 'all', label: 'All', count: state.rooms.length }].concat(depts));
  }

  function renderFileList() {
    fileList.textContent = '';
    state.files.forEach(function (file) {
      var li = el('li', 'file-item');
      var main = el('div', 'file-main');
      main.appendChild(el('span', 'file-name', file.label));
      var meta = file.sections.length + ' sections · ' + file.roomCount + ' rooms';
      if (file.estimated) meta += ' · lengths estimated';
      main.appendChild(el('span', 'file-meta', meta));
      li.appendChild(main);
      fileList.appendChild(li);
    });
  }

  function renderCoverage() {
    var classes = 0, estimated = 0;
    state.rooms.forEach(function (room) {
      classes += room.bookings.length;
      room.bookings.forEach(function (b) { if (b.estimated) estimated++; });
    });
    covRooms.textContent = state.rooms.length;
    covClasses.textContent = classes;
    covFiles.textContent = state.files.length;
    coverage.hidden = !state.files.length;

    var notes = [];
    if (state.files.length === 1) {
      notes.push('Only one timetable is published - rooms other departments use will look free until theirs are published too.');
    }
    if (estimated) {
      notes.push(estimated + ' of ' + classes + ' classes have no end time in the file, so their length is estimated.');
    }
    covNote.textContent = notes.join(' ');
    estimatesBox.hidden = !estimated;

    exportOpen.disabled = !state.rooms.length;
    exportOpen.title = state.rooms.length ? '' : 'No rooms loaded yet';

    clashOpen.disabled = !state.clashes.length;
    clashOpen.title = state.clashes.length ? '' : 'No double-booked rooms found';
    clashCount.hidden = !state.clashes.length;
    clashCount.textContent = state.clashes.length;
  }

  function renderAll() {
    renderFileList();
    renderCoverage();
    renderFacets();
    var has = state.rooms.length > 0;
    filterPanel.hidden = !has;
    resultPanel.hidden = !has;
    renderResults();
  }

  /* ---------------------------------------------------------------- input */

  function timeInputToMinutes(value) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  function minutesToTimeInput(min) {
    var h = Math.floor(min / 60), m = min % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  function currentWhen() {
    if (nowOverride.checked) {
      var minute = timeInputToMinutes(nowTime.value);
      return {
        dayIdx: parseInt(nowDay.value, 10) || 0,
        minute: minute === null ? 12 * 60 : minute
      };
    }
    var d = new Date();
    return { dayIdx: (d.getDay() + 6) % 7, minute: d.getHours() * 60 + d.getMinutes() };
  }

  function tickClock() {
    var when = currentWhen();
    nowClock.textContent = WEEKDAYS[when.dayIdx] + ', ' + fmtMinutes(when.minute) +
      (nowOverride.checked ? ' (chosen)' : '');
  }

  function fillDaySelects() {
    [nowDay, slotDay, exportDay].forEach(function (sel) {
      sel.textContent = '';
      for (var i = 0; i < 6; i++) {
        var opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = WEEKDAYS[i];
        sel.appendChild(opt);
      }
    });
    var today = (new Date().getDay() + 6) % 7;
    var pick = String(today > 5 ? 0 : today);
    nowDay.value = pick;
    slotDay.value = pick;
    exportDay.value = pick;
    nowTime.value = minutesToTimeInput(Math.min(Math.max(currentWhen().minute, DAY_START), DAY_END));
  }

  function setUploadStatus(message, kind) {
    uploadStatus.textContent = message;
    uploadStatus.className = 'status-line' + (kind ? ' ' + kind : '');
  }

  function fileLabelFor(t) {
    var bits = [];
    if (t.department) bits.push(t.department);
    if (t.semester) bits.push(t.semester);
    return bits.length ? bits.join(' · ') : (t.title || 'Timetable');
  }

  function addTimetable(t) {
    var rooms = new Set();
    var estimated = false;
    t.sections.forEach(function (sec) {
      sec.meetings.forEach(function (m) {
        if (m.room) rooms.add(roomKeyOf(m.room));
        if (!m.durMin) estimated = true;
      });
    });
    var file = {
      id: state.nextFileId++,
      label: fileLabelFor(t),
      department: t.department || t.title || 'Timetable',
      sections: t.sections,
      roomCount: rooms.size,
      estimated: estimated
    };
    state.files.push(file);
    return file;
  }

  function goToLogin() {
    location.replace(LOGIN_PATH + '?next=' + encodeURIComponent(location.pathname + location.search));
  }

  // Every timetable an admin has published in the Timetable Decoder, merged
  // into one room map.
  function loadPublished() {
    setUploadStatus('Loading the published timetables...', '');

    return loadRoomData().then(function (res) {
      if (!res.ok) {
        if (res.status === 401) return goToLogin();
        setUploadStatus('Could not load the timetables: ' + res.error.message, 'error');
        return;
      }
      res.data.timetables.forEach(addTimetable);
      rebuildIndex();
      renderAll();
      if (!state.files.length) {
        setUploadStatus('No timetables are published yet. They show up here as soon as an admin publishes them in the Timetable Decoder.', '');
        return;
      }
      setUploadStatus(state.rooms.length + ' rooms across ' + state.files.length + ' timetable' +
        (state.files.length === 1 ? '' : 's') + '.', 'success');
    });
  }

  /* ---------------------------------------------------------------- modals */

  function openModal(modal) {
    state.lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add('modal-open');
    var focusable = modal.querySelector('button');
    if (focusable) focusable.focus();
  }

  function closeModal(modal) {
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  function openRoom(key) {
    var room = state.roomByKey.get(key);
    if (!room) return;
    var when = state.mode === 'now' ? currentWhen() : { dayIdx: parseInt(slotDay.value, 10) || 0, minute: null };
    roomModalTitle.textContent = room.label;
    roomModalBody.textContent = '';

    var sources = state.files.filter(function (f) { return room.files.has(f.id); });
    roomModalBody.appendChild(el('p', 'panel-hint',
      (room.isLab ? 'Lab' : 'Classroom') + ' · ' + room.whereLabel + ' · booked by ' +
      sources.map(function (f) { return f.label; }).join(', ')));

    var exportBtn = el('button', 'btn btn-sm', 'Export free slots');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', function () {
      closeModal(roomModal);
      openExport(room.key, when.dayIdx);
    });
    roomModalBody.appendChild(exportBtn);

    for (var d = 0; d < 6; d++) {
      var day = bookingsOn(room, d);
      var wrap = el('div', 'day-block' + (d === when.dayIdx ? ' is-today' : ''));
      wrap.appendChild(el('h4', 'day-head', WEEKDAYS[d]));
      if (!day.length) {
        wrap.appendChild(el('p', 'day-free', 'Free all day'));
      } else {
        var ul = el('ul', 'day-list');
        var cursor = DAY_START;
        day.forEach(function (b) {
          if (b.startMin - cursor >= 20) {
            var gap = el('li', 'day-gap', 'Free ' + fmtMinutes(cursor) + ' - ' + fmtMinutes(b.startMin) +
              ' (' + fmtSpan(b.startMin - cursor) + ')');
            ul.appendChild(gap);
          }
          var li = el('li', 'day-item');
          li.appendChild(el('span', 'day-time', fmtMinutes(b.startMin) + ' - ' + fmtMinutes(b.endMin) + (b.estimated ? '*' : '')));
          var info = el('div', 'day-info');
          info.appendChild(el('span', 'day-course', b.code + ' (' + b.section + ')'));
          info.appendChild(el('span', 'day-meta', [b.name, b.teacher, b.fileLabel].filter(Boolean).join(' · ')));
          li.appendChild(info);
          ul.appendChild(li);
          cursor = Math.max(cursor, b.endMin);
        });
        if (DAY_END - cursor >= 20) {
          ul.appendChild(el('li', 'day-gap', 'Free ' + fmtMinutes(cursor) + ' onwards'));
        }
        wrap.appendChild(ul);
      }
      roomModalBody.appendChild(wrap);
    }
    openModal(roomModal);
  }

  function renderClashes() {
    clashListEl.textContent = '';
    var byRoom = new Map();
    state.clashes.forEach(function (c) {
      if (!byRoom.has(c.room.key)) byRoom.set(c.room.key, { room: c.room, items: [] });
      byRoom.get(c.room.key).items.push(c);
    });
    byRoom.forEach(function (group) {
      var wrap = el('div', 'clash-group');
      wrap.appendChild(el('h4', 'day-head', group.room.label));
      var ul = el('ul', 'day-list');
      group.items.forEach(function (c) {
        var li = el('li', 'day-item');
        li.appendChild(el('span', 'day-time', WEEKDAYS[c.a.dayIdx].slice(0, 3) + ' ' +
          fmtMinutes(Math.max(c.a.startMin, c.b.startMin)) + ' - ' +
          fmtMinutes(Math.min(c.a.endMin, c.b.endMin))));
        var info = el('div', 'day-info');
        info.appendChild(el('span', 'day-course', c.a.code + ' (' + c.a.section + ')  vs  ' + c.b.code + ' (' + c.b.section + ')'));
        info.appendChild(el('span', 'day-meta', c.a.fileLabel + ' vs ' + c.b.fileLabel));
        li.appendChild(info);
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
      clashListEl.appendChild(wrap);
    });
  }

  /* ---------------------------------------------------------- slot export */

  // Find the room typed into the box: a datalist pick is the exact label, but
  // "d6" / "D 6" should work too, so fall back to the key with punctuation ignored.
  function exportRoomFromInput() {
    var typed = exportRoom.value.trim();
    if (!typed) return null;
    var byLabel = state.rooms.filter(function (r) { return r.label.toLowerCase() === typed.toLowerCase(); })[0];
    if (byLabel) return byLabel;
    var bare = function (s) { return String(s).replace(/[^A-Z0-9]/gi, '').toUpperCase(); };
    var want = bare(typed);
    return state.rooms.filter(function (r) { return bare(r.key) === want; })[0] || null;
  }

  function refreshExportDays() {
    exportDays.textContent = '';
    for (var i = 0; i < TEACHING_DAYS; i++) {
      var on = state.exportDaySet.has(i);
      var b = el('button', 'chip' + (on ? ' is-on' : ''), WEEKDAYS[i]);
      b.type = 'button';
      b.setAttribute('data-xday', String(i));
      b.setAttribute('aria-pressed', String(on));
      exportDays.appendChild(b);
    }
  }

  function setExportStatus(message, kind) {
    exportStatus.textContent = message;
    exportStatus.className = 'status-line' + (kind ? ' ' + kind : '');
  }

  function renderExport() {
    var scope = state.exportScope;
    exportDayField.hidden = scope !== 'day';
    exportDaysField.hidden = scope !== 'days';
    Array.prototype.forEach.call(exportScope.children, function (c) {
      c.classList.toggle('is-on', c.getAttribute('data-scope') === scope);
    });

    state.exportReport = null;
    exportPreview.value = '';
    exportImage.removeAttribute('src');
    exportImage.parentNode.hidden = true;
    [exportCopy, exportPng, exportCopyImage].forEach(function (b) { b.disabled = true; });

    var room = exportRoomFromInput();
    if (!room) {
      var typed = exportRoom.value.trim();
      setExportStatus(typed ? 'No room matches that - pick one from the list.' : 'Choose a room to see its free slots.',
        typed ? 'error' : '');
      return;
    }
    var days = daysForScope(scope, { day: parseInt(exportDay.value, 10) || 0, days: Array.from(state.exportDaySet) });
    if (!days.length) { setExportStatus('Pick at least one day.', ''); return; }

    var from = timeInputToMinutes(exportFrom.value);
    var to = timeInputToMinutes(exportTo.value);
    if (from === null || to === null || Math.min(to, FREE_SLOT_CUTOFF) <= from) {
      setExportStatus(from !== null && from >= FREE_SLOT_CUTOFF
        ? 'Free slots stop at ' + fmtMinutes(FREE_SLOT_CUTOFF) + ', so the start time must be earlier.'
        : 'The end time must be after the start time.', 'error');
      return;
    }
    var minGap = Math.max(0, parseInt(exportGap.value, 10) || 0);

    var result = buildFreeSlots(room.bookings, { days: days, from: from, to: to, minGap: minGap });
    // result.to is the end time after the 5:30 pm cap.
    var meta = { roomLabel: room.label, where: room.whereLabel, result: result, from: result.from, to: result.to, minGap: minGap };
    var canvas = renderFreeSlotsPng(meta);
    state.exportReport = { room: room, text: formatText(meta), canvas: canvas };
    exportPreview.value = state.exportReport.text;
    exportImage.src = canvas.toDataURL('image/png');
    exportImage.parentNode.hidden = false;
    [exportCopy, exportPng, exportCopyImage].forEach(function (b) { b.disabled = false; });

    var total = result.days.reduce(function (n, d) { return n + d.slots.length; }, 0);
    setExportStatus(total + ' free slot' + (total === 1 ? '' : 's') + ' across ' + days.length + ' day' +
      (days.length === 1 ? '' : 's') + (to > FREE_SLOT_CUTOFF ? ' (nothing after ' + fmtMinutes(FREE_SLOT_CUTOFF) + ').' : '.'),
      total ? 'success' : '');
  }

  // roomKey pre-fills the room (from a room's detail view); without one the
  // person types or picks it. dayIdx seeds the "specific day" choice.
  function openExport(roomKey, dayIdx) {
    if (!state.rooms.length) return;
    exportRoomList.textContent = '';
    state.rooms.forEach(function (r) {
      var opt = document.createElement('option');
      opt.value = r.label;
      exportRoomList.appendChild(opt);
    });
    var win = teachingWindow(state.rooms, DAY_START, DAY_END);
    exportFrom.value = clock24(win.from);
    exportTo.value = clock24(win.to);
    exportTo.max = clock24(FREE_SLOT_CUTOFF);

    var picked = roomKey ? state.roomByKey.get(roomKey) : null;
    exportRoom.value = picked ? picked.label : '';
    if (typeof dayIdx === 'number' && dayIdx < TEACHING_DAYS) exportDay.value = String(dayIdx);
    state.exportScope = 'day';
    state.exportDaySet = new Set([parseInt(exportDay.value, 10) || 0]);
    refreshExportDays();
    renderExport();
    openModal(exportModal);
    if (!picked) exportRoom.focus();
  }

  function downloadBlob(name, blob) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function canvasBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) { if (blob) resolve(blob); else reject(new Error('no image')); }, 'image/png');
    });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      exportPreview.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  }

  /* ---------------------------------------------------------------- events */

  exportOpen.addEventListener('click', function () { openExport(null); });
  exportClose.addEventListener('click', function () { closeModal(exportModal); });
  document.querySelector('[data-close-export]').addEventListener('click', function () { closeModal(exportModal); });

  exportScope.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-scope]');
    if (!btn) return;
    state.exportScope = btn.getAttribute('data-scope');
    renderExport();
  });
  exportDays.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-xday]');
    if (!btn) return;
    var i = parseInt(btn.getAttribute('data-xday'), 10);
    if (state.exportDaySet.has(i)) state.exportDaySet.delete(i); else state.exportDaySet.add(i);
    refreshExportDays();
    renderExport();
  });
  [exportRoom, exportFrom, exportTo, exportGap].forEach(function (input) {
    input.addEventListener('input', renderExport);
  });
  exportDay.addEventListener('change', renderExport);

  exportCopy.addEventListener('click', function () {
    if (!state.exportReport) return;
    copyText(state.exportReport.text).then(
      function () { setExportStatus('Copied to the clipboard.', 'success'); },
      function () { setExportStatus('Could not copy - select the text and copy it by hand.', 'error'); }
    );
  });
  exportPng.addEventListener('click', function () {
    var report = state.exportReport;
    if (!report) return;
    canvasBlob(report.canvas).then(
      function (blob) { downloadBlob('free-slots-' + report.room.key.toLowerCase() + '.png', blob); },
      function () { setExportStatus('Could not create the image.', 'error'); }
    );
  });
  exportCopyImage.addEventListener('click', function () {
    var report = state.exportReport;
    if (!report) return;
    if (!(navigator.clipboard && window.ClipboardItem && window.isSecureContext)) {
      setExportStatus('This browser cannot copy images - use Download PNG instead.', 'error');
      return;
    }
    navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasBlob(report.canvas) })]).then(
      function () { setExportStatus('Image copied to the clipboard.', 'success'); },
      function () { setExportStatus('Could not copy the image - use Download PNG instead.', 'error'); }
    );
  });

  [theoryMinInput, labMinInput].forEach(function (input) {
    input.addEventListener('change', function () { rebuildIndex(); renderAll(); });
  });

  roomSearch.addEventListener('input', function () {
    state.query = roomSearch.value.trim().toLowerCase();
    renderResults();
  });

  kindRow.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-kind]');
    if (!btn) return;
    state.kind = btn.getAttribute('data-kind');
    Array.prototype.forEach.call(kindRow.children, function (c) { c.classList.toggle('is-on', c === btn); });
    renderResults();
  });

  buildingRow.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-building]');
    if (!btn) return;
    state.building = btn.getAttribute('data-building');
    state.floor = 'all';
    renderFacets();
    renderResults();
  });

  floorRow.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-floor]');
    if (!btn) return;
    state.floor = btn.getAttribute('data-floor');
    renderFacets();
    renderResults();
  });

  deptRow.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-dept]');
    if (!btn) return;
    state.dept = btn.getAttribute('data-dept');
    renderFacets();
    renderResults();
  });

  groupRow.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-group]');
    if (!btn) return;
    state.groupBy = btn.getAttribute('data-group');
    Array.prototype.forEach.call(groupRow.children, function (c) { c.classList.toggle('is-on', c === btn); });
    renderResults();
  });

  minfreeRow.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-min]');
    if (!btn) return;
    state.minFree = parseInt(btn.getAttribute('data-min'), 10) || 0;
    Array.prototype.forEach.call(minfreeRow.children, function (c) { c.classList.toggle('is-on', c === btn); });
    renderResults();
  });

  durRow.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-dur]');
    if (!btn) return;
    slotDur.value = btn.getAttribute('data-dur');
    renderResults();
  });

  showBusy.addEventListener('change', renderResults);
  showLate.addEventListener('change', renderResults);

  function setMode(mode) {
    state.mode = mode;
    var isNow = mode === 'now';
    tabNow.classList.toggle('is-on', isNow);
    tabSlot.classList.toggle('is-on', !isNow);
    tabNow.setAttribute('aria-selected', String(isNow));
    tabSlot.setAttribute('aria-selected', String(!isNow));
    queryNow.hidden = !isNow;
    querySlot.hidden = isNow;
    renderResults();
  }

  tabNow.addEventListener('click', function () { setMode('now'); });
  tabSlot.addEventListener('click', function () { setMode('slot'); });

  nowOverride.addEventListener('change', function () {
    nowOverrideGrid.hidden = !nowOverride.checked;
    tickClock();
    renderResults();
  });
  [nowDay, nowTime].forEach(function (input) {
    input.addEventListener('change', function () { tickClock(); renderResults(); });
  });
  nowRefresh.addEventListener('click', function () { tickClock(); renderResults(); });
  [slotDay, slotStart, slotDur].forEach(function (input) {
    input.addEventListener('change', renderResults);
    input.addEventListener('input', renderResults);
  });

  [freeList, busyList].forEach(function (container) {
    container.addEventListener('click', function (e) {
      var card = e.target.closest('[data-room]');
      if (card) openRoom(card.getAttribute('data-room'));
    });
  });

  clashOpen.addEventListener('click', function () { renderClashes(); openModal(clashModal); });
  clashClose.addEventListener('click', function () { closeModal(clashModal); });
  roomClose.addEventListener('click', function () { closeModal(roomModal); });
  document.querySelector('[data-close-clash]').addEventListener('click', function () { closeModal(clashModal); });
  document.querySelector('[data-close-room]').addEventListener('click', function () { closeModal(roomModal); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!exportModal.hidden) closeModal(exportModal);
    else if (!roomModal.hidden) closeModal(roomModal);
    else if (!clashModal.hidden) closeModal(clashModal);
    else if (!passwordModal.hidden) closeModal(passwordModal);
  });

  /* --------------------------------------------------------------- account */

  function showAccount(account) {
    accountName.textContent = account.displayName || account.username;
    accountName.title = account.username;
    accountBar.hidden = false;
  }

  signoutBtn.addEventListener('click', function () {
    signoutBtn.disabled = true;
    signoutBtn.textContent = 'Logging out...';
    signOut().then(function () { location.replace(LOGIN_PATH); });
  });

  function setPasswordStatus(message, kind, invalidInput) {
    passwordStatus.textContent = message;
    passwordStatus.className = 'status-line' + (kind ? ' ' + kind : '');
    [pwCurrent, pwNew, pwConfirm].forEach(function (input) { input.removeAttribute('aria-invalid'); });
    if (invalidInput) {
      invalidInput.setAttribute('aria-invalid', 'true');
      invalidInput.focus();
    }
  }

  passwordOpen.addEventListener('click', function () {
    passwordForm.reset();
    setPasswordStatus('', '');
    openModal(passwordModal);
    pwCurrent.focus();
  });
  passwordClose.addEventListener('click', function () { closeModal(passwordModal); });
  document.querySelector('[data-close-password]').addEventListener('click', function () { closeModal(passwordModal); });

  passwordForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (passwordSubmit.disabled) return;
    if (!pwCurrent.value) return setPasswordStatus('Enter your current password.', 'error', pwCurrent);
    if (pwNew.value.length < MIN_PASSWORD) {
      return setPasswordStatus('Use at least ' + MIN_PASSWORD + ' characters for the new password.', 'error', pwNew);
    }
    if (pwNew.value !== pwConfirm.value) return setPasswordStatus('Those passwords don’t match.', 'error', pwConfirm);

    passwordSubmit.disabled = true;
    setPasswordStatus('Updating...', '');
    changePassword({ currentPassword: pwCurrent.value, newPassword: pwNew.value }).then(function (res) {
      passwordSubmit.disabled = false;
      if (res.ok) {
        passwordForm.reset();
        setPasswordStatus('Password updated. Other devices were signed out.', 'success');
        return;
      }
      if (res.status === 401) return goToLogin();
      var field = res.error.code === 'INVALID_CREDENTIALS' ? pwCurrent
        : res.error.code === 'WEAK_PASSWORD' ? pwNew
        : null;
      setPasswordStatus(res.error.message, 'error', field);
    });
  });

  /* ------------------------------------------------------------------ boot */

  fillDaySelects();
  tickClock();
  requireAccount().then(function (account) {
    if (!account) return;
    showAccount(account);
    loadPublished();
    setInterval(function () {
      if (nowOverride.checked) return;
      tickClock();
      if (state.mode === 'now') renderResults();
    }, 30000);
  });
})();
