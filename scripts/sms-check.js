// SMS diagnostics — run where the API runs (same .env):
//
//   npm run sms:check                                  driver + recent SMS log
//   npm run sms:check -- --to 01712345678              …and send one test SMS right now
//   npm run sms:check -- --to 01712345678 --text "…"   …with your own text
//
// Sends directly through the driver (no job), so you see the provider's answer here.
// Prints no API keys.
import { parseArgs } from 'node:util';
import { connectDB, disconnectDB } from '#config/db.js';
import { getIntegrationConfig } from '#integrations/config.js';
import { analyzeSms, sendSms, SmsSendError } from '#integrations/sms/index.js';
import { normalizeBdPhone } from '#shared/utils/phone.js';
import { getCurrentOrg } from '#modules/organizations/organization.service.js';
import { SmsMessage } from '#modules/sms/smsMessage.model.js';

const { values: a } = parseArgs({ options: { to: { type: 'string' }, text: { type: 'string' } } });
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => console.log(`  ✘ ${m}`);
const mask = (v) => (v ? `${String(v).slice(0, 3)}***` : '—');

const HINTS = {
  AUTH_FAILED:
    'API key/token is wrong or the account is disabled — copy it again from the provider panel into SMS_API_KEY.',
  SENDER_ID_INVALID:
    'SMS_SENDER_ID is not approved for this key — use the exact sender ID/number shown in the provider panel.',
  IP_NOT_WHITELISTED:
    "Add this server's public IP to the provider's IP whitelist (BulkSMSBD: Phonebook › IP White List).",
  INSUFFICIENT_BALANCE: 'Recharge the SMS balance.',
  MASKING_NEEDS_BANGLA: 'Masking SMS on this account must be in Bangla.',
  PROVIDER_UNREACHABLE: 'Cannot reach the provider — internet/firewall, or SMS_API_URL is wrong.',
};

console.log('\n1) Configuration');
const cfg = getIntegrationConfig(null, 'sms');
console.log(
  `  driver=${cfg.driver} senderId=${cfg.senderId ?? '—'} apiKey=${mask(cfg.apiKey)} ` +
    `costPerSegment=${cfg.costPerSegmentPoisha ?? '—'} poisha`,
);
if (cfg.driver === 'log')
  bad('SMS_DRIVER=log — messages are written to the API log, nothing is sent.');
else ok(`Live driver: ${cfg.driver}`);

if (a.to) {
  console.log('\n2) Test SMS');
  const to = normalizeBdPhone(a.to);
  if (!to) {
    bad(`"${a.to}" is not a Bangladesh mobile number`);
  } else {
    const text = a.text ?? 'PrimePlot test SMS / পরীক্ষামূলক এসএমএস';
    const s = analyzeSms(text);
    console.log(`  to=${to} · ${s.encoding} · ${s.chars} chars · ${s.segments} segment(s)`);
    try {
      const r = await sendSms(null, { to, text, clientRef: `chk${Date.now().toString(36)}` });
      ok(`Accepted by ${r.driver}${r.providerMessageId ? ` (ref ${r.providerMessageId})` : ''}`);
    } catch (err) {
      bad(err.message);
      if (err instanceof SmsSendError && HINTS[err.code]) console.log(`    → ${HINTS[err.code]}`);
    }
  }
}

console.log('\n3) Recent SMS (newest first)');
try {
  await connectDB();
  const org = await getCurrentOrg();
  if (org) {
    const rows = await SmsMessage.find({ orgId: org._id }).sort({ createdAt: -1 }).limit(10).lean();
    if (!rows.length) console.log('  (none yet)');
    for (const m of rows) {
      console.log(
        `  ${m.createdAt.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}  ${m.status.padEnd(8)} ` +
          `${m.purpose.padEnd(16)} ${m.to}  ${m.segments} seg${m.error?.code ? `  ${m.error.code}: ${m.error.message ?? ''}` : ''}`,
      );
    }
  }
} catch (err) {
  bad(`Database: ${err.message}`);
} finally {
  await disconnectDB().catch(() => {});
}
console.log('');
