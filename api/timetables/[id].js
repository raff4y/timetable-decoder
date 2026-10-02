import { route } from '../../server/http.js';
import { requireApprovedUser, requireAdmin } from '../../server/auth.js';
import { createTimetableHandlers } from './_lib.js';

const { item } = createTimetableHandlers({ requireApprovedUser, requireAdmin });

// GET    /api/timetables/:id  - timetable + sections (students: published only)
// PATCH  /api/timetables/:id  - admin: { department?, semester?, title?, isPublished? }
// DELETE /api/timetables/:id  - admin
export default route({ GET: item.GET, PATCH: item.PATCH, DELETE: item.DELETE });
