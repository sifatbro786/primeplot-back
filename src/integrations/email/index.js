import nodemailer from 'nodemailer';
import { env } from '#config/env.js';
import { logger } from '#config/logger.js';
import { getIntegrationConfig } from '#integrations/config.js';

const log = logger.child({ module: 'email' });
let transporter = null;

function getTransporter(cfg) {
  transporter ??= nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    pool: true,
    maxConnections: 2,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

/**
 * Send one email. Call it from a job (email.send), not inline in a request, so SMTP latency
 * and outages never hit the user and failures retry.
 * When SMTP isn't configured: dev logs the message (links included, so flows can be tested
 * without a mailbox); production logs only that it was skipped.
 */
export async function sendEmail(orgId, { to, subject, html, text, attachments }) {
  const cfg = getIntegrationConfig(orgId, 'email');
  if (!cfg.enabled) {
    if (env.isProd) log.warn({ subject }, 'Email skipped — SMTP not configured');
    else log.info({ to, subject, text }, 'Email (not sent — SMTP not configured)');
    return { skipped: true };
  }
  const info = await getTransporter(cfg).sendMail({
    from: cfg.from,
    to,
    subject,
    html,
    text,
    attachments,
  });
  log.info({ messageId: info.messageId, subject }, 'Email sent');
  return { messageId: info.messageId };
}

export function closeEmail() {
  transporter?.close();
  transporter = null;
}
