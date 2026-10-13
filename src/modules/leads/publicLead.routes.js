import { Router } from 'express';
import { logger } from '#config/logger.js';
import { limiter } from '#shared/middleware/rateLimit.js';
import { validate } from '#shared/middleware/validate.js';
import { created } from '#shared/utils/response.js';
import { createWebsiteLead } from './lead.service.js';
import { zPublicLead } from './lead.validation.js';

/**
 * POST /api/v1/public/leads — the website enquiry forms (buyer + landowner). No auth.
 * Defences: strict schema, per-IP rate limit, honeypot field (`hp`) and minimum fill time
 * (`elapsedMs` < 2.5 s). A bot gets the same 201 as a person, so it learns nothing.
 * Repeat enquiries from the same phone land on the existing open lead.
 */
const log = logger.child({ module: 'public-leads' });
const MIN_FILL_MS = 2_500;
const router = Router();

router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.post(
  '/',
  limiter({ name: 'public-leads', windowMs: 10 * 60_000, limit: 5 }),
  validate({ body: zPublicLead }),
  async (req, res) => {
    const body = req.valid.body;
    if (body.hp || (body.elapsedMs !== undefined && body.elapsedMs < MIN_FILL_MS)) {
      log.info(
        { ip: req.ip, hp: Boolean(body.hp), elapsedMs: body.elapsedMs },
        'Website lead dropped as a bot',
      );
      return created(res, { received: true });
    }
    await createWebsiteLead(req.orgId, body);
    created(res, { received: true });
  },
);

export default router;
