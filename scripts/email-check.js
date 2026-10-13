// Email diagnostics — run on the machine/server that runs the API (same .env):
//
//   npm run email:check                          SMTP login check + recent email jobs
//   npm run email:check -- --to you@example.com  …and send a test email
//   npm run email:check -- --user staff@x.com    …and show whether that login email exists
//
// Prints no passwords or tokens.
import { parseArgs } from 'node:util';
import nodemailer from 'nodemailer';
import { env } from '#config/env.js';
import { connectDB, disconnectDB } from '#config/db.js';
import { getIntegrationConfig } from '#integrations/config.js';
import { Organization } from '#modules/organizations/organization.model.js';
import { User } from '#modules/users/user.model.js';
import { Job } from '#jobs/job.model.js';

const { values: a } = parseArgs({ options: { to: { type: 'string' }, user: { type: 'string' } } });
const mask = (e) => (e ? String(e).replace(/^(.{2}).*(@.*)$/, '$1***$2') : '—');
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => console.log(`  ✘ ${m}`);

function hint(err) {
  const m = `${err.code ?? ''} ${err.responseCode ?? ''} ${err.message ?? ''}`;
  if (/EAUTH|535|534|Username and Password not accepted/i.test(m))
    return 'Login rejected. For Gmail: turn on 2-Step Verification, create an App Password (Google Account › Security › App passwords) and put that 16-character password in SMTP_PASS (no spaces). Your normal Gmail password will not work.';
  if (/ETIMEDOUT|ECONNREFUSED|ESOCKET|EAI_AGAIN|ENOTFOUND/i.test(m))
    return 'Cannot reach the SMTP server. Check SMTP_HOST/SMTP_PORT, your internet/firewall/antivirus; Gmail: 465 with SMTP_SECURE=true, or 587 with SMTP_SECURE=false.';
  if (/wrong version number|SSL routines/i.test(m))
    return 'TLS mismatch: port 465 needs SMTP_SECURE=true, port 587 needs SMTP_SECURE=false.';
  return null;
}

console.log('\n1) Configuration');
const cfg = getIntegrationConfig(null, 'email');
console.log(
  `  host=${cfg.host ?? '—'} port=${cfg.port ?? '—'} secure=${cfg.secure} user=${mask(cfg.user)} from=${cfg.from ? mask(cfg.from) : '—'}`,
);
console.log(`  CLIENT_URL=${env.CLIENT_URL}  JOBS_ENABLED=${env.JOBS_ENABLED}`);
if (!cfg.enabled)
  bad(
    'Email is OFF: SMTP_HOST, SMTP_USER and SMTP_PASS must all be set. Emails are only logged in the API console.',
  );
if (!env.JOBS_ENABLED)
  bad('JOBS_ENABLED=false — queued emails are never sent by this API process.');

console.log('\n2) SMTP login');
let smtpOk = false;
if (cfg.enabled) {
  const t = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await t.verify();
    smtpOk = true;
    ok('SMTP server accepted the login');
    if (a.to) {
      const info = await t.sendMail({
        from: cfg.from,
        to: a.to,
        subject: `${env.APP_NAME} — test email`,
        text: `This is a test from ${env.APP_NAME} (${new Date().toISOString()}). If you got it, SMTP works.`,
      });
      ok(`Test email sent to ${a.to} (id ${info.messageId}). Check Inbox and Spam.`);
    }
  } catch (err) {
    bad(`${err.code ?? 'ERROR'} ${err.responseCode ?? ''} ${err.message}`.trim());
    const h = hint(err);
    if (h) console.log(`    → ${h}`);
  } finally {
    t.close();
  }
}

console.log('\n3) Recent email jobs (newest first)');
try {
  await connectDB();
  const org = await Organization.findOne(env.ORG_SLUG ? { slug: env.ORG_SLUG } : {}).lean();
  if (!org) throw new Error('Organization not found — run npm run seed first');
  const jobs = await Job.find({ orgId: org._id, type: 'email.send' })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
  if (!jobs.length)
    console.log(
      '  (none) — nothing has been queued. A forgot-password request for an email that is not a user (or a disabled user) sends nothing, on purpose.',
    );
  for (const j of jobs) {
    const when = new Date(j.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' });
    const tpl = j.payload?.template ?? (j.sensitive ? '(auth link — payload wiped)' : '?');
    console.log(
      `  ${when}  ${j.status.padEnd(9)} attempts=${j.attempts}  ${tpl}  to=${mask(j.payload?.to)}${j.lastError ? `\n      lastError: ${j.lastError}` : ''}`,
    );
  }
  if (jobs.some((j) => j.status === 'queued' && new Date(j.runAt) < Date.now() - 120_000))
    bad('Some jobs are overdue — is the API (npm run dev) running with JOBS_ENABLED=true?');

  if (a.user) {
    console.log('\n4) Login email lookup');
    const u = await User.findOne({ orgId: org._id, email: a.user.trim().toLowerCase() }).lean();
    if (!u)
      bad(
        `No user with ${a.user} in "${org.name}" — forgot-password silently does nothing for unknown emails.`,
      );
    else
      ok(
        `User found: status=${u.status}, language=${u.locale}${u.status === 'disabled' ? ' — disabled users get no email' : ''}`,
      );
  }
} catch (err) {
  bad(`Database: ${err.message}`);
} finally {
  await disconnectDB().catch(() => {});
}
console.log(smtpOk ? '\nDone.\n' : '\nFix the ✘ items above, restart the API, then try again.\n');
process.exit(0);
