// SSLCommerz diagnostics (B5.2) — run where the API runs (same .env). No database needed.
//
//   npm run sslcz:check                         config + callback URLs + is the IPN URL reachable
//   npm run sslcz:check -- --session            …and open a ৳10 sandbox session (prints the payment page)
//   npm run sslcz:check -- --session --amount 1500
//   npm run sslcz:check -- --validate <val_id>  ask the Order Validation API about a val_id
//   npm run sslcz:check -- --query <tran_id>    ask the Transaction Query API about a tran_id
//
// Prints no passwords. A --session made here is not linked to any booking: paying it in the
// sandbox only proves the store keys and URLs work (the API logs "unknown tran_id" — expected).
import { parseArgs } from 'node:util';
import { env } from '#config/env.js';
import * as sslcz from '#integrations/payments/sslcommerz.js';
import { callbackUrls, newTranId } from '#modules/payments/payment.service.js';

const { values: a } = parseArgs({
  options: {
    session: { type: 'boolean', default: false },
    amount: { type: 'string' },
    validate: { type: 'string' },
    query: { type: 'string' },
  },
});
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => console.log(`  ✘ ${m}`);
const info = (m) => console.log(`    ${m}`);
const mask = (v) => (v ? `${String(v).slice(0, 4)}***` : '—');

const cfg = sslcz.sslczConfig(null);
let failed = false;

console.log('\n1) Configuration');
info(
  `SSLCZ_STORE_ID=${cfg.storeId ?? '—'}  SSLCZ_STORE_PASS=${mask(cfg.storePass)}  mode=${cfg.isLive ? 'LIVE (real money)' : 'sandbox'}`,
);
if (!cfg.enabled) {
  bad('Store ID / password missing — online payment stays hidden in the portal.');
  info('Sandbox store (free): https://developer.sslcommerz.com/registration/');
  process.exit(1);
}
ok(`Keys present → gateway ${cfg.host}`);

console.log('\n2) Callback URLs (sent with every session)');
const urls = callbackUrls();
for (const [k, v] of Object.entries(urls)) info(`${k.padEnd(7)} ${v}`);
const local = /localhost|127\.0\.0\.1/.test(env.apiUrl);
if (local) {
  bad(
    'API_PUBLIC_URL is localhost — the browser redirect works, but SSLCommerz cannot deliver the IPN.',
  );
  info('Start a tunnel and set API_PUBLIC_URL to its https address (docs/SSLCOMMERZ.md).');
  info(
    'Without the IPN, the reconcile job still finds paid attempts (every 10 min, after 15 min).',
  );
} else ok(`API_PUBLIC_URL=${env.apiUrl}`);

console.log('\n3) Is this API reachable at API_PUBLIC_URL? (the server must be running)');
try {
  const r = await fetch(`${env.apiUrl}/api/v1/health`, { signal: AbortSignal.timeout(8000) });
  if (r.ok) ok(`GET ${env.apiUrl}/api/v1/health → ${r.status}`);
  else bad(`GET ${env.apiUrl}/api/v1/health → HTTP ${r.status}`);
} catch (err) {
  bad(
    `Not reachable (${err.name === 'TimeoutError' ? 'timeout' : err.message}) — is \`npm run dev\` running / the tunnel up?`,
  );
}

if (a.session) {
  console.log('\n4) Test session');
  const amount = Math.round(Number(a.amount ?? 10) * 100);
  const tranId = newTranId();
  try {
    const s = await sslcz.initSession(null, {
      tranId,
      amount,
      urls,
      customer: { name: 'Sandbox Test', email: 'test@example.com', phone: '01700000000' },
      product: { name: 'PrimePlot sandbox check', category: 'Real Estate' },
    });
    ok(`Session opened — tran_id ${tranId}, ৳${(amount / 100).toFixed(2)}`);
    info(`Open in a browser: ${s.gatewayUrl}`);
    if (!cfg.isLive)
      info(
        'Sandbox card: see https://developer.sslcommerz.com/doc/v4/#test-the-integration (any OTP shown there)',
      );
  } catch (err) {
    failed = true;
    bad(`${err.code}: ${err.message}`);
    if (err.code === 'GATEWAY_REFUSED')
      info(
        'Usually a wrong Store ID/password, or a live key with SSLCZ_IS_LIVE=false (or the reverse).',
      );
  }
}

if (a.validate) {
  console.log('\n5) Order Validation API');
  try {
    const v = await sslcz.validate(null, a.validate);
    info(JSON.stringify(v, null, 2).replace(/\n/g, '\n    '));
    if (['VALID', 'VALIDATED'].includes(v.status))
      ok(`${v.status} — ৳${((v.currencyAmount ?? v.amount) / 100).toFixed(2)} risk=${v.riskLevel}`);
    else bad(`status ${v.status || '(empty)'}`);
  } catch (err) {
    failed = true;
    bad(`${err.code}: ${err.message}`);
  }
}

if (a.query) {
  console.log('\n6) Transaction Query API');
  try {
    const list = await sslcz.queryByTranId(null, a.query);
    if (!list.length) bad('SSLCommerz has no attempt for this tran_id');
    for (const t of list)
      info(
        `${t.status}  val_id=${t.valId ?? '—'}  ৳${t.amount != null ? (t.amount / 100).toFixed(2) : '?'}  ${t.cardType ?? ''}`,
      );
  } catch (err) {
    failed = true;
    bad(`${err.code}: ${err.message}`);
  }
}

console.log('');
process.exit(failed ? 1 : 0);
