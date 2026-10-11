// First-run setup: creates the organization and the first Admin. Safe to re-run (idempotent).
//
//   npm run seed -- --org-name "Acme Properties Ltd" --org-slug acme \
//                   --admin-name "Sifat" --admin-email you@example.com [--admin-password "…"]
//
// Without --admin-password a strong random password is generated and printed ONCE.
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import { connectDB, disconnectDB } from '#config/db.js';
import { hashPassword } from '#shared/crypto/password.js';
import { normalizeBdPhone } from '#shared/utils/phone.js';
import { Organization } from '#modules/organizations/organization.model.js';
import { User } from '#modules/users/user.model.js';
import { AuditLog } from '#modules/audit/audit.model.js';
// Registered so --sync-indexes covers every collection.
import '#modules/auth/session.model.js';
import '#modules/auth/authToken.model.js';
import '#modules/media/media.model.js';
import '#jobs/job.model.js';
import { assertPasswordAllowed, zPassword } from '#modules/auth/passwordPolicy.js';

const { values: a } = parseArgs({
  options: {
    'org-name': { type: 'string' },
    'org-slug': { type: 'string' },
    'org-phone': { type: 'string' },
    'admin-name': { type: 'string' },
    'admin-email': { type: 'string' },
    'admin-password': { type: 'string' },
    'sync-indexes': { type: 'boolean', default: false },
  },
});

const orgName = a['org-name'] ?? process.env.SEED_ORG_NAME;
const orgSlug = (a['org-slug'] ?? process.env.SEED_ORG_SLUG ?? '').toLowerCase();
const adminName = a['admin-name'] ?? process.env.SEED_ADMIN_NAME;
const adminEmail = (a['admin-email'] ?? process.env.SEED_ADMIN_EMAIL ?? '').trim().toLowerCase();
let adminPassword = a['admin-password'] ?? process.env.SEED_ADMIN_PASSWORD;

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (!orgName || !orgSlug || !adminName || !adminEmail) {
  fail(
    'Missing arguments. Usage:\n  npm run seed -- --org-name "Acme Properties Ltd" --org-slug acme ' +
      '--admin-name "Your Name" --admin-email you@example.com',
  );
}
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(orgSlug))
  fail('--org-slug: lowercase letters, digits and dashes only');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) fail('--admin-email is not a valid email');

let generated = false;
if (!adminPassword) {
  adminPassword = randomBytes(15).toString('base64url'); // 20 chars, ~120 bits
  generated = true;
}
const pw = zPassword.safeParse(adminPassword);
if (!pw.success) fail(pw.error.issues[0].message);
try {
  assertPasswordAllowed(adminPassword, { email: adminEmail, name: adminName });
} catch (err) {
  fail(err.details?.[0]?.message ?? err.message);
}

await connectDB({ retries: 2 });
try {
  if (a['sync-indexes']) {
    // Production has autoIndex off — build indexes explicitly once per deploy.
    await mongoose.syncIndexes();
    console.log('✔ Indexes synced');
  }

  let org = await Organization.findOne({ slug: orgSlug });
  if (org) {
    console.log(`• Organization "${org.name}" (${org.slug}) already exists — kept as is`);
  } else {
    const phone = a['org-phone'] ? normalizeBdPhone(a['org-phone']) : null;
    org = await Organization.create({ name: orgName, slug: orgSlug, phone });
    console.log(`✔ Organization created: ${org.name} (${org.slug})`);
  }

  const existingAdmin = await User.findOne({
    orgId: org._id,
    role: 'admin',
    status: 'active',
  }).lean();
  const sameEmail = await User.findOne({ orgId: org._id, email: adminEmail }).lean();
  if (sameEmail) {
    console.log(
      `• User ${adminEmail} already exists (${sameEmail.role}, ${sameEmail.status}) — not changed`,
    );
  } else if (existingAdmin) {
    console.log(`• An active admin already exists (${existingAdmin.email}) — no new admin created`);
  } else {
    const user = await User.create({
      orgId: org._id,
      name: adminName,
      email: adminEmail,
      role: 'admin',
      status: 'active',
      passwordHash: await hashPassword(adminPassword),
      passwordChangedAt: new Date(),
    });
    await AuditLog.create({
      orgId: org._id,
      action: 'system.seed',
      actor: { kind: 'system' },
      entity: { type: 'User', id: user._id },
      meta: { org: org.slug },
    });
    console.log(`✔ Admin created: ${adminEmail}`);
    if (generated) {
      console.log(`\n  Temporary password (shown once): ${adminPassword}`);
      console.log('  Sign in and change it from your profile.\n');
    }
  }
  if (!process.env.ORG_SLUG) console.log(`\nTip: add ORG_SLUG=${org.slug} to .env`);
} finally {
  await disconnectDB();
}
