import { Router } from 'express';
import healthRoutes from '#modules/health/health.routes.js';
import authRoutes from '#modules/auth/auth.routes.js';
import orgRoutes from '#modules/organizations/organization.routes.js';
import userRoutes from '#modules/users/user.routes.js';
import auditRoutes from '#modules/audit/audit.routes.js';
import mediaRoutes from '#modules/media/media.routes.js';
import internalRoutes from '#jobs/jobs.routes.js';
import { limits } from '#shared/middleware/rateLimit.js';
import { originGuard } from '#shared/middleware/originGuard.js';
import { resolveOrg } from '#shared/middleware/resolveOrg.js';

/** /api/v1 — every module mounts here. */
const api = Router();

// Infra endpoints: no org resolution, no browser-origin checks.
api.use('/health', healthRoutes);
api.use('/internal', internalRoutes);

// Cross-origin webhooks/callbacks (Meta, SSLCommerz) will mount HERE, before originGuard.

api.use(limits.api);
api.use(originGuard);
api.use(resolveOrg);

api.use('/auth', authRoutes);
api.use('/org', orgRoutes);
api.use('/users', userRoutes);
api.use('/audit', auditRoutes);
api.use('/media', mediaRoutes);

export default api;
