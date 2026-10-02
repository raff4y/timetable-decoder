// GET /api/rooms/data (Room Finder session) -> { timetables: [{ id, department,
//   semester, title, explicitDurations, sections }] }
//
// Every PUBLISHED timetable, so the Room Finder merges whatever the admins have
// published in the timetable tool into one room map. `sections` has the same
// shape as GET /api/timetables/:id (meetings carry room, durMin, isLab).

import { route, sendJson } from '../../server/http.js';
import { query } from '../../server/db.js';
import { requireRoomAccount } from '../../server/rooms/auth.js';
import { loadSections } from '../timetables/_lib.js';

export default route({
  GET: async (req, res) => {
    await requireRoomAccount(req);
    const { rows } = await query(
      `SELECT id, department, semester, title, explicit_durations
         FROM timetables WHERE is_published
        ORDER BY department, created_at`,
    );
    const timetables = await Promise.all(
      rows.map(async (t) => ({
        id: t.id,
        department: t.department,
        semester: t.semester,
        title: t.title,
        explicitDurations: t.explicit_durations,
        sections: await loadSections(t.id),
      })),
    );
    sendJson(res, 200, { timetables });
  },
});
