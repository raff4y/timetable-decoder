import { route } from '../../server/http.js';
import { requireApprovedUser } from '../../server/auth.js';
import { createScheduleHandlers } from './_lib.js';

const handlers = createScheduleHandlers({ requireApprovedUser });

// GET /api/schedules/:timetableId - the caller's saved schedule, or { schedule: null }
// PUT /api/schedules/:timetableId - { sectionKeys: string[], colorAssignments: {} }
export default route({ GET: handlers.GET, PUT: handlers.PUT });
