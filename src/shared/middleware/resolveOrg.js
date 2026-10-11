import { getCurrentOrg } from '#modules/organizations/organization.service.js';

/** Sets req.org / req.orgId for every tenant-scoped route (cached lookup). */
export async function resolveOrg(req, res, next) {
  const org = await getCurrentOrg();
  req.org = org;
  req.orgId = org._id;
  next();
}
