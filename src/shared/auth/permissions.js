/**
 * RBAC (ARCHITECTURE §3.7): code checks PERMISSIONS, never role names. A role is only a bundle.
 * Permissions for later phases are declared now so role bundles stay reviewable in one place.
 * Object-level checks (own leads, own bookings, own media) live in each module's service.
 */
export const P = Object.freeze({
  // Organization & people
  ORG_READ: 'org:read',
  ORG_UPDATE: 'org:update',
  USERS_READ: 'users:read',
  USERS_MANAGE: 'users:manage',
  AUDIT_READ: 'audit:read',
  SETTINGS_INTEGRATIONS: 'settings:integrations',
  JOBS_MANAGE: 'jobs:manage',

  // Media
  MEDIA_UPLOAD: 'media:upload', // public + private
  MEDIA_UPLOAD_PRIVATE: 'media:upload_private', // private only (clients: bank slips)
  MEDIA_READ_PRIVATE: 'media:read_private', // any private file in the org
  MEDIA_DELETE: 'media:delete', // anyone's media (own media can always be deleted)

  // Inventory (B2)
  PROJECTS_READ: 'projects:read',
  PROJECTS_WRITE: 'projects:write',
  UNITS_READ: 'units:read',
  UNITS_WRITE: 'units:write',
  UNITS_HOLD: 'units:hold',
  UNITS_BLOCK: 'units:block',
  PRICING_WRITE: 'pricing:write',

  // CRM (B3)
  LEADS_READ_OWN: 'leads:read_own',
  LEADS_READ_ALL: 'leads:read_all',
  LEADS_WRITE: 'leads:write',
  LEADS_ASSIGN: 'leads:assign',
  PIPELINE_MANAGE: 'pipeline:manage',

  // Website content & SEO (B2b)
  SITE_MANAGE: 'site:manage',

  // Sales & accounts (B4)
  BOOKINGS_READ: 'bookings:read', // own bookings (sold by me) and their customers
  BOOKINGS_READ_ALL: 'bookings:read_all',
  BOOKINGS_CREATE: 'bookings:create',
  BOOKINGS_OVERRIDE: 'bookings:override', // book without booking money (reason), custom schedule
  DISCOUNT_UNLIMITED: 'bookings:discount_unlimited', // no per-role discount cap
  PLANS_MANAGE: 'plans:manage', // payment plan templates
  BOOKINGS_CANCEL: 'bookings:cancel',
  ACCOUNTS_READ: 'accounts:read',
  RECEIPTS_CREATE: 'receipts:create',
  RECEIPTS_REVERSE: 'receipts:reverse',
  CHEQUES_MANAGE: 'cheques:manage',
  PAYMENT_SLIPS_VERIFY: 'payment_slips:verify',
  DOCUMENTS_ISSUE: 'documents:issue',
  REPORTS_READ: 'reports:read',
  ACCOUNTS_SETTINGS: 'accounts:settings', // discount limits, bank accounts, receipt options

  // Customer portal (B5)
  PORTAL_ACCESS: 'portal:access', // the client role itself
  PORTAL_MANAGE: 'portal:manage', // client logins (disable/enable), profile change requests
  ONLINE_PAYMENTS_REVIEW: 'online_payments:review', // SSLCommerz payments held for review
  REMINDERS_MANAGE: 'reminders:manage', // run / preview reminders, delivery log
  ANALYTICS_READ: 'analytics:read',
});

export const ALL_PERMISSIONS = Object.freeze(Object.values(P));

export const ROLES = Object.freeze(['admin', 'sales_manager', 'sales_executive', 'client']);
export const STAFF_ROLES = Object.freeze(['admin', 'sales_manager', 'sales_executive']);

const SALES_EXECUTIVE = [
  P.ORG_READ,
  P.MEDIA_UPLOAD,
  P.PROJECTS_READ,
  P.UNITS_READ,
  P.UNITS_HOLD,
  P.LEADS_READ_OWN,
  P.LEADS_WRITE,
  P.BOOKINGS_READ,
  P.BOOKINGS_CREATE,
  P.ACCOUNTS_READ,
];

const SALES_MANAGER = [
  ...SALES_EXECUTIVE,
  P.USERS_READ,
  P.AUDIT_READ,
  P.MEDIA_READ_PRIVATE,
  P.MEDIA_DELETE,
  P.PROJECTS_WRITE,
  P.UNITS_WRITE,
  P.UNITS_BLOCK,
  P.LEADS_READ_ALL,
  P.LEADS_ASSIGN,
  P.PIPELINE_MANAGE,
  P.SITE_MANAGE,
  P.BOOKINGS_READ_ALL,
  P.BOOKINGS_OVERRIDE,
  P.PLANS_MANAGE,
  P.BOOKINGS_CANCEL,
  P.RECEIPTS_CREATE,
  P.CHEQUES_MANAGE,
  P.PAYMENT_SLIPS_VERIFY,
  P.DOCUMENTS_ISSUE,
  P.REPORTS_READ,
  P.PORTAL_MANAGE,
  P.ONLINE_PAYMENTS_REVIEW,
  P.REMINDERS_MANAGE,
  P.ANALYTICS_READ,
];

const ROLE_PERMISSIONS = {
  admin: ALL_PERMISSIONS.filter((p) => p !== P.PORTAL_ACCESS),
  sales_manager: SALES_MANAGER,
  sales_executive: SALES_EXECUTIVE,
  client: [P.PORTAL_ACCESS, P.MEDIA_UPLOAD_PRIVATE],
};

const SETS = Object.freeze(
  Object.fromEntries(Object.entries(ROLE_PERMISSIONS).map(([r, ps]) => [r, new Set(ps)])),
);

export function permissionsFor(role) {
  return SETS[role] ?? new Set();
}

export function hasPermission(role, permission) {
  return permissionsFor(role).has(permission);
}

export function isStaff(role) {
  return STAFF_ROLES.includes(role);
}
