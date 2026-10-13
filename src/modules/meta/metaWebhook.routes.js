import { Router } from 'express';
import { logger } from '#config/logger.js';
import { getIntegrationConfig } from '#integrations/config.js';
import { verifyWebhookSignature } from '#integrations/meta/graph.js';
import { safeEqual } from '#shared/crypto/secrets.js';
import { limiter } from '#shared/middleware/rateLimit.js';
import { receiveWebhook } from './meta.service.js';

/**
 * /api/v1/webhooks/meta — called by Meta's servers (no cookies, no browser Origin), so it is
 * mounted before originGuard/resolveOrg; the org comes from the Page id in the event.
 *   GET  — subscription check: echo hub.challenge when hub.verify_token matches.
 *   POST — leadgen events, signed with X-Hub-Signature-256 over the raw body (app.js keeps it).
 * Answer fast: events are stored and imported by a job.
 */
const log = logger.child({ module: 'meta-webhook' });
const router = Router();

router.use(limiter({ name: 'meta-webhook', windowMs: 60_000, limit: 600 }));
router.use((req, res, next) => {
  if (!getIntegrationConfig(null, 'meta').enabled) return res.status(404).end();
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const { verifyToken } = getIntegrationConfig(null, 'meta');
  if (
    mode === 'subscribe' &&
    typeof token === 'string' &&
    safeEqual(token, verifyToken) &&
    typeof challenge === 'string' &&
    /^[\w-]{1,128}$/.test(challenge)
  ) {
    return res.status(200).type('text/plain').send(challenge);
  }
  log.warn({ ip: req.ip }, 'Meta webhook verification refused');
  return res.status(403).end();
});

router.post('/', async (req, res) => {
  const { appSecret } = getIntegrationConfig(null, 'meta');
  if (!verifyWebhookSignature(req.rawBody, req.get('x-hub-signature-256'), appSecret)) {
    log.warn({ ip: req.ip }, 'Meta webhook with a bad signature — rejected');
    return res.status(401).end();
  }
  const result = await receiveWebhook(req.body);
  if (result.accepted || result.ignored) log.info(result, 'Meta webhook');
  res.status(200).type('text/plain').send('EVENT_RECEIVED');
});

export default router;
