import { Router } from 'express';
import healthRoutes from '#modules/health/health.routes.js';
import authRoutes from '#modules/auth/auth.routes.js';
import orgRoutes from '#modules/organizations/organization.routes.js';
import userRoutes from '#modules/users/user.routes.js';
import auditRoutes from '#modules/audit/audit.routes.js';
import mediaRoutes from '#modules/media/media.routes.js';
import projectRoutes from '#modules/projects/project.routes.js';
import unitRoutes from '#modules/units/unit.routes.js';
import floorPlanRoutes from '#modules/floorplans/floorplan.routes.js';
import publicRoutes from '#modules/public/public.routes.js';
import leadRoutes from '#modules/leads/lead.routes.js';
import publicLeadRoutes from '#modules/leads/publicLead.routes.js';
import notificationRoutes from '#modules/notifications/notification.routes.js';
import integrationRoutes from '#modules/integrations/integration.routes.js';
import metaWebhookRoutes from '#modules/meta/metaWebhook.routes.js';
import internalRoutes from '#jobs/jobs.routes.js';
import { limits } from '#shared/middleware/rateLimit.js';
import { originGuard } from '#shared/middleware/originGuard.js';
import { resolveOrg } from '#shared/middleware/resolveOrg.js';

/** /api/v1 — every module mounts here. */
const api = Router();

// Infra endpoints: no org resolution, no browser-origin checks.
api.use('/health', healthRoutes);
api.use('/internal', internalRoutes);

// Cross-origin webhooks/callbacks (Meta; SSLCommerz later) — before originGuard and resolveOrg.
api.use('/webhooks/meta', metaWebhookRoutes);

api.use(limits.api);
api.use(originGuard);
api.use(resolveOrg);

api.use('/auth', authRoutes);
api.use('/org', orgRoutes);
api.use('/users', userRoutes);
api.use('/audit', auditRoutes);
api.use('/media', mediaRoutes);
api.use('/projects', projectRoutes);
api.use('/units', unitRoutes);
api.use('/floorplans', floorPlanRoutes);
api.use('/leads', leadRoutes);
api.use('/notifications', notificationRoutes);
api.use('/integrations', integrationRoutes);
api.use('/public/leads', publicLeadRoutes); // website enquiry form — before the cached catalogue
api.use('/public', publicRoutes); // website catalogue — no auth

export default api;
