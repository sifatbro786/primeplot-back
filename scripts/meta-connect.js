// Meta Lead Ads from the command line (until the dashboard screen ships in F4).
// Run where the API runs (same .env, META_APP_SECRET + META_VERIFY_TOKEN set):
//
//   npm run meta:connect -- --page 1234567890 --token EAAB…   connect the Page (stores it encrypted)
//   npm run meta:connect -- --status                          connection + last imports
//   npm run meta:connect -- --forms                           the Page's lead forms
//   npm run meta:connect -- --sync                            import the last 48 h now
//   npm run meta:connect -- --disconnect
//
// --token: a Page access token, or a (system) user token that can manage the Page — the Page
// token is derived from it. Prints no tokens.
import { parseArgs } from 'node:util';
import { connectDB, disconnectDB } from '#config/db.js';
import { getIntegrationConfig } from '#integrations/config.js';
import { P } from '#shared/auth/permissions.js';
import { getCurrentOrg } from '#modules/organizations/organization.service.js';
import { listActiveStaffWith } from '#modules/users/user.service.js';
import * as meta from '#modules/meta/meta.service.js';

const { values: a } = parseArgs({
  options: {
    page: { type: 'string' },
    token: { type: 'string' },
    status: { type: 'boolean', default: false },
    forms: { type: 'boolean', default: false },
    sync: { type: 'boolean', default: false },
    disconnect: { type: 'boolean', default: false },
  },
});
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => console.log(`  ✘ ${m}`);

const cfg = getIntegrationConfig(null, 'meta');
console.log(`\nMeta Lead Ads · Graph ${cfg.graphVersion}`);
if (!cfg.enabled) {
  bad('META_APP_SECRET and META_VERIFY_TOKEN are not set in .env — nothing to do.');
  process.exit(1);
}

try {
  await connectDB();
  const org = await getCurrentOrg();
  const ctx = { orgId: org._id, actor: { kind: 'system' }, requestId: 'cli:meta-connect' };

  if (a.page && a.token) {
    const [adminUser] = await listActiveStaffWith(org._id, P.SETTINGS_INTEGRATIONS);
    if (!adminUser) throw new Error('No active admin user found');
    const s = await meta.connectPage({
      orgId: org._id,
      user: adminUser,
      pageId: a.page,
      accessToken: a.token,
      ctx,
    });
    ok(
      `Connected "${s.connection.pageName}" (${s.connection.pageId}), webhook subscribed; importing the last 48 h…`,
    );
  }
  if (a.disconnect) {
    await meta.disconnectPage({ orgId: org._id, ctx });
    ok('Disconnected');
  }
  if (a.sync) {
    const r = await meta.reconcile(org._id, { force: true });
    if (r.skipped) bad(`Skipped: ${r.skipped}`);
    else
      ok(
        `Checked ${r.checked}, imported ${r.imported}, failed ${r.failed}${r.error ? ` — ${r.error}` : ''}`,
      );
  }
  if (a.forms) {
    for (const f of await meta.listPageForms(org._id)) {
      console.log(
        `  ${f.id}  ${String(f.status ?? '').padEnd(9)} ${f.name ?? ''}${f.mapping ? `  → ${f.mapping.type}` : ''}`,
      );
    }
  }
  if (a.status || !(a.page || a.disconnect || a.sync || a.forms)) {
    const s = await meta.metaStatus(org._id);
    const c = s.connection;
    if (!c) bad('No Page connected');
    else {
      (c.status === 'active' ? ok : bad)(
        `${c.pageName} (${c.pageId}) · ${c.status}${c.lastError ? ` — ${c.lastError.message}` : ''}`,
      );
      console.log(
        `  last lead: ${c.lastLeadAt?.toISOString?.() ?? '—'} · last nightly check: ${c.lastReconciledAt?.toISOString?.() ?? '—'}`,
      );
    }
    console.log(
      `  webhook URL: <your API host>${s.webhookPath}  (verify token = META_VERIFY_TOKEN)`,
    );
    console.log(`  last 7 days: ${JSON.stringify(s.last7Days)}`);
  }
} catch (err) {
  bad(err.details?.[0]?.message ?? err.message);
  process.exitCode = 1;
} finally {
  await disconnectDB().catch(() => {});
}
console.log('');
