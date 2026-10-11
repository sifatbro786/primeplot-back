import { Router } from 'express';
import { env } from '#config/env.js';
import { safeEqual } from '#shared/crypto/secrets.js';
import { NotFoundError, UnauthorizedError } from '#shared/errors/AppError.js';
import { limits } from '#shared/middleware/rateLimit.js';
import { ok } from '#shared/utils/response.js';
import { tick } from './scheduler.js';

/**
 * POST /api/v1/internal/cron/tick  (header: X-Cron-Secret)
 * Manual/ops trigger — the in-process interval already ticks. Disabled (404) without CRON_SECRET.
 */
const router = Router();

router.post('/cron/tick', limits.internal, async (req, res) => {
  if (!env.CRON_SECRET) throw new NotFoundError();
  if (!safeEqual(req.get('x-cron-secret') ?? '', env.CRON_SECRET)) throw new UnauthorizedError();
  const processed = await tick();
  ok(res, { processed });
});

export default router;
