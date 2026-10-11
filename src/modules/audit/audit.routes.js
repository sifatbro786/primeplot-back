import { Router } from 'express';
import { z } from 'zod';
import { P } from '#shared/auth/permissions.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { cursorQuery } from '#shared/utils/pagination.js';
import { ok } from '#shared/utils/response.js';
import { authenticate, authorize } from '#modules/auth/auth.middleware.js';
import { listAudit } from './audit.service.js';

const router = Router();

router.get(
  '/',
  authenticate,
  authorize(P.AUDIT_READ),
  validate({
    query: {
      ...cursorQuery,
      action: z
        .string()
        .regex(/^[a-z_]+(\.[a-z_]*)*$/)
        .max(80)
        .optional(),
      entityType: z
        .string()
        .regex(/^[A-Za-z]+$/)
        .max(40)
        .optional(),
      entityId: zid.optional(),
      actorId: zid.optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    },
  }),
  async (req, res) => {
    const { items, meta } = await listAudit(req.orgId, req.valid.query);
    ok(res, items, { meta });
  },
);

export default router;
