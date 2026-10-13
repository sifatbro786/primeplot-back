import { Router } from 'express';
import { z } from 'zod';
import { validate, zid } from '#shared/middleware/validate.js';
import { ok } from '#shared/utils/response.js';
import { cursorQuery } from '#shared/utils/pagination.js';
import { authenticate } from '#modules/auth/auth.middleware.js';
import * as notifications from './notification.service.js';

/** /api/v1/notifications — the signed-in user's own notifications (no extra permission). */
const router = Router();
router.use(authenticate);

router.get(
  '/',
  validate({ query: { ...cursorQuery, unread: z.enum(['true', 'false']).optional() } }),
  async (req, res) => {
    const { unread, ...q } = req.valid.query;
    const { items, meta } = await notifications.listNotifications(req.orgId, req.user.id, {
      ...q,
      unread: unread === 'true',
    });
    ok(res, items, { meta });
  },
);

router.get('/unread-count', async (req, res) => {
  ok(res, { count: await notifications.unreadCount(req.orgId, req.user.id) });
});

router.post(
  '/read',
  validate({
    body: z.union([
      z.object({ all: z.literal(true) }).strict(),
      z.object({ ids: z.array(zid).min(1).max(200) }).strict(),
    ]),
  }),
  async (req, res) => {
    const updated = await notifications.markRead(req.orgId, req.user.id, req.valid.body);
    ok(res, { updated });
  },
);

export default router;
