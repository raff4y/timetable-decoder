// Course Demand: what students actually put in their saved schedules for one
// timetable. One call: GET /api/admin/insights?timetableId=.

import { api, card, clear, emptyState, errorState, h, linkButton, pageHead, select, skeleton, statTile, table } from '../ui.js';
import { barList, columnChart } from '../charts.js';
import { dayName, formatDecimal, formatNumber, percent, plural } from '../format.js';

export async function render(ctx) {
  const picker = h('div', { class: 'filters' });
  const host = h('div');
  ctx.view.append(
    pageHead({
      eyebrow: 'Insights',
      title: 'Course Demand',
      description: 'Which courses, sections and teachers students pick, from their saved schedules.',
    }),
    picker,
    host,
  );
  host.append(skeleton(110, 260, 320));

  async function load(timetableId) {
    host.classList.add('is-refreshing');
    const res = await api(`/admin/insights${timetableId ? `?timetableId=${encodeURIComponent(timetableId)}` : ''}`);
    if (!ctx.isCurrent()) return;
    host.classList.remove('is-refreshing');
    if (!res.ok) {
      if (res.status === 404 && timetableId) {
        ctx.setQuery({});
        return load('');
      }
      clear(host, errorState(res.error.message, () => load(timetableId)));
      return;
    }
    const d = res.data;
    if (!d.timetable) {
      clear(picker);
      clear(host, card({ body: emptyState({ icon: 'chart', title: 'No Timetables Yet', text: 'Upload and publish a timetable; demand shows up once students save schedules.', action: linkButton('Go To Timetables', '#/timetables', { variant: 'primary' }) }) }));
      return;
    }
    ctx.setQuery({ t: d.timetable.id });
    const sel = select(
      d.timetables.map((t) => [t.id, `${t.title || 'Untitled'}${t.semester ? ` · ${t.semester}` : ''}${t.isPublished ? '' : ' (Draft)'}`]),
      d.timetable.id,
      { 'aria-label': 'Timetable', style: 'min-width:min(100%,360px)' },
    );
    sel.addEventListener('change', () => load(sel.value));
    clear(picker, sel, linkButton('Open Timetable', `#/timetables/${d.timetable.id}`, { icon: 'calendar' }));
    clear(host, ...draw(d));
  }

  await load(ctx.route.query.get('t') || '');
}

function draw(d) {
  const s = d.summary;
  const out = [
    h(
      'div',
      { class: 'grid grid--4' },
      statTile({ label: 'Saved Schedules', value: formatNumber(s.schedules), icon: 'book', sub: d.timetable.isPublished ? 'Students with at least one section' : 'Draft: students can’t see it yet' }),
      statTile({ label: 'Sections Per Schedule', value: formatDecimal(s.avgSections), icon: 'layers', sub: 'Average across saved schedules' }),
      statTile({ label: 'Courses Picked', value: formatNumber(s.coursesPicked), unit: `of ${formatNumber(s.coursesTotal)}`, icon: 'chart', sub: `${percent(s.coursesPicked, s.coursesTotal)}% of the catalog` }),
      statTile({ label: 'Sections Picked', value: formatNumber(s.sectionsPicked), unit: `of ${formatNumber(s.sectionsTotal)}`, icon: 'calendar', sub: `${percent(s.sectionsPicked, s.sectionsTotal)}% have at least one student` }),
    ),
  ];

  if (!s.schedules) {
    out.push(card({ body: emptyState({ icon: 'book', title: 'No Saved Schedules Yet', text: d.timetable.isPublished ? 'Demand appears here as soon as students save schedules for this timetable.' : 'Publish this timetable so students can start building schedules from it.' }) }));
    return out;
  }

  const days = [0, 1, 2, 3, 4, 5].map((i) => ({ label: dayName(i, true), tipLabel: dayName(i), value: d.dayLoad.find((x) => x.dayIdx === i)?.meetings || 0 }));
  if (!days[5].value) days.pop(); // no Saturday classes picked: leave it off
  const sizes = d.scheduleSizes.map((x) => ({ label: String(x.size), tipLabel: plural(x.size, 'section'), value: x.schedules }));

  out.push(
    h(
      'div',
      { class: 'grid grid--2' },
      card({
        title: 'Classes By Weekday',
        description: 'Picked classes students attend on each day',
        body: columnChart(days, { unit: 'classes', caption: 'Picked classes by weekday', firstColumn: 'Day' }),
      }),
      card({
        title: 'Schedule Size',
        description: 'Saved schedules by number of sections in them',
        body: columnChart(sizes, { unit: 'schedules', caption: 'Schedules by number of sections', firstColumn: 'Sections' }),
      }),
    ),
  );

  out.push(
    card({
      title: 'Most Wanted Courses',
      description: 'Students with any section of the course in their schedule',
      flush: true,
      body: table(
        [
          { label: 'Course', main: true },
          { label: 'Students', className: 'num' },
          { label: 'Share', className: 'num' },
          { label: 'Sections Used', className: 'num' },
        ],
        d.topCourses.map((c) => [
          h('div', { class: 'cell-title' }, h('strong', null, c.code), h('span', null, c.name)),
          formatNumber(c.students),
          `${percent(c.students, s.schedules)}%`,
          formatNumber(c.sections),
        ]),
        { caption: 'Most wanted courses' },
      ),
    }),
  );

  out.push(
    h(
      'div',
      { class: 'grid grid--2' },
      card({
        title: 'Fullest Sections',
        description: 'Students who saved each section',
        body: barList(d.topSections.slice(0, 10).map((x) => ({ label: `${x.code} ${x.section}`, sub: x.teacher || x.name, value: x.students })), { unit: 'students' }),
      }),
      card({
        title: 'Teachers By Students',
        description: `Across the sections students saved · ${plural(s.teachersTotal, 'teacher')} in this timetable`,
        body: barList(d.topTeachers.slice(0, 10).map((x) => ({ label: x.teacher, sub: plural(x.sections, 'section'), value: x.students })), { unit: 'students' }),
      }),
    ),
  );

  if (d.unpickedCourses.length) {
    out.push(
      card({
        title: 'Courses Nobody Has Picked',
        description: `${plural(d.unpickedCourses.length, 'course')} with no section in any saved schedule${d.unpickedCourses.length >= 50 ? ' (first 50)' : ''}`,
        body: h('div', { class: 'chips' }, d.unpickedCourses.map((c) => h('span', { class: 'chip', title: c.name }, h('b', null, c.code), ` ${c.name}`))),
      }),
    );
  }
  return out;
}
