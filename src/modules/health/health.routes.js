import { Router } from 'express';
import { env } from '#config/env.js';
import { isDBReady } from '#config/db.js';
import { ok } from '#shared/utils/response.js';

const router = Router();
const startedAt = new Date();

// Liveness: the process is up. Never touches the DB, so a DB outage doesn't get the
// process restarted in a loop by PM2 / uptime monitors.
router.get('/', (req, res) => {
  ok(res, {
    status: 'ok',
    app: env.APP_NAME,
    env: env.NODE_ENV,
    uptimeSec: Math.round(process.uptime()),
    startedAt,
  });
});

// Readiness: able to serve real traffic (DB reachable). 503 otherwise.
router.get('/ready', async (req, res) => {
  const db = await isDBReady();
  res.status(db ? 200 : 503).json({
    success: db,
    data: {
      status: db ? 'ready' : 'not_ready',
      checks: { database: db ? 'up' : 'down' },
      features: env.features,
    },
  });
});

export default router;
