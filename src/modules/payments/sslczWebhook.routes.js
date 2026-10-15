import { Router } from 'express';
import { logger } from '#config/logger.js';
import { getIntegrationConfig } from '#integrations/config.js';
import { limiter } from '#shared/middleware/rateLimit.js';
import { handleCallback, returnUrl } from './payment.service.js';

/**
 * /api/v1/webhooks/sslcommerz — reached by SSLCommerz (IPN, server to server) and by the
 * client's browser coming back from the payment page (success / fail / cancel, a cross-site
 * form POST: no cookies, no allowed Origin). Mounted before originGuard and resolveOrg; the
 * payment (and its org) is found by our tran_id.
 *
 * Nothing posted here is trusted: a VALID claim only makes us call the Order Validation API.
 */
const log = logger.child({ module: 'sslcz-webhook' });
const router = Router();

router.use(limiter({ name: 'sslcz-webhook', windowMs: 60_000, limit: 300 }));
router.use((req, res, next) => {
  if (!getIntegrationConfig(null, 'payment').enabled) return res.status(404).end();
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const params = (req) => ({ ...(req.query ?? {}), ...(req.body ?? {}) });

for (const kind of ['success', 'fail', 'cancel']) {
  const handler = async (req, res) => {
    let payment = null;
    try {
      payment = await handleCallback(kind, params(req));
    } catch (err) {
      log.error(
        { kind, err: { message: err.message, code: err.code } },
        'SSLCommerz return failed',
      );
    }
    // 303: the browser follows with a GET to the portal page, which shows the live status.
    res.redirect(303, returnUrl(payment, kind));
  };
  router.post(`/${kind}`, handler);
  router.get(`/${kind}`, handler);
}

router.post('/ipn', async (req, res) => {
  try {
    await handleCallback('ipn', params(req));
  } catch (err) {
    // 500 makes SSLCommerz retry the IPN; the reconcile job is the second safety net.
    log.error({ err: { message: err.message, code: err.code } }, 'SSLCommerz IPN failed');
    return res.status(500).type('text/plain').send('ERROR');
  }
  res.status(200).type('text/plain').send('OK');
});

export default router;
