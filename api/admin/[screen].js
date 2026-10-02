import { route } from '../../server/http.js';
import { requireAdmin } from '../../server/auth.js';
import { createCmsHandler } from './_cms.js';

// GET /api/admin/{stats|insights|activity|timetables|timetable} - admin CMS screens.
// One function for all of them (see _cms.js); /api/admin/users stays its own
// file and wins over this dynamic route, on Vercel and in the dev server alike.
export default route({ GET: createCmsHandler({ requireAdmin }) });
