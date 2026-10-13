import { env } from '#config/env.js';

/**
 * Integration config resolver (ARCHITECTURE §6.5). Every module asks HERE, never env directly,
 * so SaaS mode can later swap env for encrypted per-org settings without touching modules.
 * v1: single-tenant → env for every org.
 */
export function getIntegrationConfig(_orgId, name) {
  switch (name) {
    case 'email':
      return {
        enabled: env.features.email,
        host: env.SMTP_HOST,
        port: env.SMTP_PORT ?? (env.SMTP_SECURE ? 465 : 587),
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        from: env.SMTP_FROM ?? (env.SMTP_USER ? `${env.APP_NAME} <${env.SMTP_USER}>` : undefined),
      };
    case 'sms':
      return {
        enabled: env.features.sms,
        driver: env.SMS_DRIVER,
        apiKey: env.SMS_API_KEY,
        senderId: env.SMS_SENDER_ID,
        apiUser: env.SMS_API_USER,
        apiPass: env.SMS_API_PASS,
        baseUrl: env.SMS_API_URL,
        costPerSegmentPoisha: env.SMS_COST_PER_SEGMENT_POISHA ?? null,
      };
    case 'payment':
      return {
        enabled: env.features.sslcommerz,
        provider: 'sslcommerz',
        storeId: env.SSLCZ_STORE_ID,
        storePass: env.SSLCZ_STORE_PASS,
        isLive: env.SSLCZ_IS_LIVE,
      };
    case 'meta':
      // App-level secrets only; the connected Page (+ its encrypted token) lives in the DB.
      return {
        enabled: env.features.metaLeads,
        appId: env.META_APP_ID,
        appSecret: env.META_APP_SECRET,
        verifyToken: env.META_VERIFY_TOKEN,
        graphVersion: env.META_GRAPH_VERSION,
      };
    default:
      throw new Error(`Unknown integration: ${name}`);
  }
}

/** Safe-to-expose flags for the frontend (hide disabled features). Never includes secrets. */
export function integrationStatus(orgId) {
  return {
    email: getIntegrationConfig(orgId, 'email').enabled,
    sms: getIntegrationConfig(orgId, 'sms').enabled,
    onlinePayment: getIntegrationConfig(orgId, 'payment').enabled,
    metaLeads: getIntegrationConfig(orgId, 'meta').enabled,
  };
}
