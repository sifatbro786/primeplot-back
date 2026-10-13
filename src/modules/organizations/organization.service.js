import { env } from '#config/env.js';
import { AppError, NotFoundError } from '#shared/errors/AppError.js';
import { diffFields } from '#shared/utils/diff.js';
import { Organization } from './organization.model.js';

/**
 * Single-tenant resolution: one deployment = one organization (ORG_SLUG, or the only org).
 * Cached briefly — every request needs it. SaaS later: resolve by host/subdomain here and
 * nothing else changes (every query is already orgId-scoped).
 */
const TTL_MS = 60_000;
let cached = null; // { org, at }

export function invalidateOrgCache() {
  cached = null;
}

export async function getCurrentOrg() {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.org;

  const filter = env.ORG_SLUG ? { slug: env.ORG_SLUG } : {};
  const orgs = await Organization.find(filter).sort({ createdAt: 1 }).limit(2).lean();
  if (!orgs.length) {
    throw new AppError('Organization is not set up yet. Run `npm run seed`.', {
      statusCode: 503,
      code: 'ORG_NOT_CONFIGURED',
    });
  }
  if (!env.ORG_SLUG && orgs.length > 1) {
    throw new AppError('More than one organization exists — set ORG_SLUG in .env', {
      statusCode: 500,
      code: 'ORG_AMBIGUOUS',
    });
  }
  const org = orgs[0];
  if (org.status !== 'active') {
    throw new AppError('This account is suspended', { statusCode: 403, code: 'ORG_SUSPENDED' });
  }
  cached = { org, at: Date.now() };
  return org;
}

export async function listActiveOrgIds() {
  const orgs = await Organization.find({ status: 'active' }).select('_id').lean();
  return orgs.map((o) => o._id);
}

export function toPublicOrg(org) {
  return {
    id: String(org._id),
    name: org.name,
    nameBn: org.nameBn ?? null,
    slug: org.slug,
    legalName: org.legalName ?? null,
    email: org.email ?? null,
    phone: org.phone ?? null,
    address: org.address ?? null,
    addressBn: org.addressBn ?? null,
    website: org.website ?? null,
    tradeLicenseNo: org.tradeLicenseNo ?? null,
    rehabMemberNo: org.rehabMemberNo ?? null,
    logoMediaId: org.logoMediaId ? String(org.logoMediaId) : null,
    settings: org.settings,
    analytics: {
      ga4MeasurementId: org.analytics?.ga4MeasurementId ?? null,
      metaPixelId: org.analytics?.metaPixelId ?? null,
    },
  };
}

const EDITABLE = [
  'name',
  'nameBn',
  'legalName',
  'email',
  'phone',
  'address',
  'addressBn',
  'website',
  'tradeLicenseNo',
  'rehabMemberNo',
  'logoMediaId',
];

/** @returns {{ org, diff }} */
export async function updateOrg(orgId, patch) {
  const org = await Organization.findOne({ _id: orgId });
  if (!org) throw new NotFoundError('Organization not found');
  const before = org.toObject();

  for (const k of EDITABLE) if (k in patch) org.set(k, patch[k]);
  if (patch.settings) {
    for (const [k, v] of Object.entries(patch.settings)) org.set(`settings.${k}`, v);
  }
  if (patch.analytics) {
    for (const [k, v] of Object.entries(patch.analytics)) org.set(`analytics.${k}`, v);
  }
  await org.save();
  invalidateOrgCache();
  return {
    org: org.toObject(),
    diff: diffFields(before, org.toObject(), [...EDITABLE, 'settings', 'analytics']),
  };
}
