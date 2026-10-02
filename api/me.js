// GET /api/me -> { user }. Creates / links the app_users row on first call after
// sign-up (idempotent). Works for pending, rejected and disabled users too.

import { route, sendJson } from '../server/http.js';
import { requireUser, toPublicUser } from '../server/auth.js';

export default route({
  GET: async (req, res) => {
    const user = await requireUser(req, { allowPending: true });
    sendJson(res, 200, { user: toPublicUser(user) });
  },
});
