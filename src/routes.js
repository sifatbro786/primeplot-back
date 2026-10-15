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
import siteRoutes from '#modules/site/site.routes.js';
import { projectUpdatesRouter, updatesRouter } from '#modules/construction/construction.routes.js';
import metaWebhookRoutes from '#modules/meta/metaWebhook.routes.js';
import customerRoutes from '#modules/customers/customer.routes.js';
import { bookingRouter, planRouter } from '#modules/bookings/booking.routes.js';
import { accountsRouter, receiptRouter } from '#modules/accounts/accounts.routes.js';
import { bookingActions, chequeRouter, reportRouter } from '#modules/bookings/lifecycle.routes.js';
import {
  bookingDocuments,
  documentRouter,
  verifyRouter,
} from '#modules/bookings/document.routes.js';
import portalRoutes from '#modules/portal/portal.routes.js';
import {
  customerPortalRouter,
  profileRequestRouter,
  slipRouter,
} from '#modules/portal/portalStaff.routes.js';
import onlinePaymentRoutes from '#modules/payments/payment.routes.js';
import sslczWebhookRoutes from '#modules/payments/sslczWebhook.routes.js';
import { bookingRemindRouter, reminderRouter } from '#modules/reminders/reminder.routes.js';
import analyticsRoutes from '#modules/analytics/analytics.routes.js';
import internalRoutes from '#jobs/jobs.routes.js';
import { limits } from '#shared/middleware/rateLimit.js';
import { originGuard } from '#shared/middleware/originGuard.js';
import { resolveOrg } from '#shared/middleware/resolveOrg.js';

/** /api/v1 — every module mounts here. */
const api = Router();

// Infra endpoints: no org resolution, no browser-origin checks.
api.use('/health', healthRoutes);
api.use('/internal', internalRoutes);

// Cross-origin webhooks/callbacks (Meta, SSLCommerz) — before originGuard and resolveOrg.
api.use('/webhooks/meta', metaWebhookRoutes);
api.use('/webhooks/sslcommerz', sslczWebhookRoutes); // B5.2

api.use(limits.api);
api.use(originGuard);
api.use(resolveOrg);

api.use('/auth', authRoutes);
api.use('/org', orgRoutes);
api.use('/users', userRoutes);
api.use('/audit', auditRoutes);
api.use('/media', mediaRoutes);
api.use('/projects', projectUpdatesRouter); // /projects/:id/updates (B2b)
api.use('/projects', projectRoutes);
api.use('/construction-updates', updatesRouter);
api.use('/units', unitRoutes);
api.use('/floorplans', floorPlanRoutes);
api.use('/leads', leadRoutes);
api.use('/notifications', notificationRoutes);
api.use('/integrations', integrationRoutes);
api.use('/site', siteRoutes);
api.use('/customers', customerPortalRouter); // B5.1 /customers/:id/portal…
api.use('/customers', customerRoutes); // B4
api.use('/bookings', bookingRouter);
api.use('/bookings', bookingActions); // B4.2
api.use('/bookings', bookingDocuments); // B4.3
api.use('/cheques', chequeRouter);
api.use('/reports', reportRouter);
api.use('/documents', documentRouter);
api.use('/payment-plans', planRouter);
api.use('/receipts', receiptRouter);
api.use('/accounts', accountsRouter);
api.use('/portal', portalRoutes); // B5.1 customer portal (client logins)
api.use('/payment-slips', slipRouter);
api.use('/profile-requests', profileRequestRouter);
api.use('/online-payments', onlinePaymentRoutes); // B5.2
api.use('/reminders', reminderRouter); // B5.3
api.use('/bookings', bookingRemindRouter);
api.use('/analytics', analyticsRoutes);
api.use('/public/verify', verifyRouter); // B4.3 QR verification — not cached
api.use('/public/leads', publicLeadRoutes); // website enquiry form — before the cached catalogue
api.use('/public', publicRoutes); // website catalogue — no auth

export default api;
