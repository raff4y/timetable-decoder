import { route } from '../../server/http.js';
import { requireApprovedUser, requireAdmin } from '../../server/auth.js';
import { createTimetableHandlers } from './_lib.js';

const { index } = createTimetableHandlers({ requireApprovedUser, requireAdmin });

// GET  /api/timetables  - list (students: published only)
// POST /api/timetables  - admin upload: raw xlsx bytes, X-Filename header
export default route({ GET: index.GET, POST: index.POST });
