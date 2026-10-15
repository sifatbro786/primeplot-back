import { Router } from 'express';
import { z } from 'zod';
import { P } from '#shared/auth/permissions.js';
import { BadRequestError } from '#shared/errors/AppError.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { ok } from '#shared/utils/response.js';
import { authenticate, authorizeAny } from '#modules/auth/auth.middleware.js';
import * as analytics from './analytics.service.js';

/**
 * /api/v1/analytics — dashboard aggregations (B5.3). `from`/`to` are Dhaka dates (default: the
 * last 12 months), at most 3 years apart. analytics:read or reports:read.
 */
const router = Router();
router.use(authenticate, authorizeAny(P.ANALYTICS_READ, P.REPORTS_READ));

const zRange = {
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  projectId: zid.optional(),
};
const checkRange = (q) => {
  const { from, to } = analytics.defaultRange(q);
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days < 0 || days > 3 * 366) {
    throw new BadRequestError('Pick a range of up to 3 years (from ≤ to)', {
      code: 'INVALID_RANGE',
    });
  }
  return q;
};

for (const [path, fn] of Object.entries({
  overview: analytics.overview,
  inventory: analytics.inventory,
  sales: analytics.sales,
  collections: analytics.collections,
  pipeline: analytics.pipeline,
  portal: analytics.portal,
})) {
  router.get(`/${path}`, validate({ query: zRange }), async (req, res) => {
    ok(res, await fn(req.orgId, checkRange(req.valid.query)));
  });
}

export default router;
