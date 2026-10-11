import { Router } from 'express';
import { z } from 'zod';
import { P } from '#shared/auth/permissions.js';
import { BadRequestError } from '#shared/errors/AppError.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { ok } from '#shared/utils/response.js';
import { normalizeBdPhone } from '#shared/utils/phone.js';
import { integrationStatus } from '#integrations/config.js';
import { authenticate, authorize } from '#modules/auth/auth.middleware.js';
import { audit, auditContext } from '#modules/audit/audit.service.js';
import { toPublicOrg, updateOrg } from './organization.service.js';

const router = Router();

/** Public: branding for the login page / public site header (no secrets). */
router.get('/public', (req, res) => {
  const o = toPublicOrg(req.org);
  ok(res, {
    name: o.name,
    nameBn: o.nameBn,
    logoMediaId: o.logoMediaId,
    phone: o.phone,
    email: o.email,
    address: o.address,
    addressBn: o.addressBn,
    website: o.website,
    defaultLocale: o.settings?.defaultLocale ?? 'bn',
    features: { onlinePayment: integrationStatus(req.orgId).onlinePayment },
  });
});

router.get('/', authenticate, authorize(P.ORG_READ), (req, res) => {
  ok(res, { ...toPublicOrg(req.org), features: integrationStatus(req.orgId) });
});

const str = (max) => z.string().trim().max(max).nullable().optional();

router.patch(
  '/',
  authenticate,
  authorize(P.ORG_UPDATE),
  validate({
    body: z
      .object({
        name: z.string().trim().min(2).max(160).optional(),
        nameBn: str(160),
        legalName: str(200),
        email: z.email().max(254).nullable().optional(),
        phone: str(20),
        address: str(500),
        addressBn: str(500),
        // http(s) only — the value is rendered as a link on receipts and the public site.
        website: z
          .url({ protocol: /^https?$/ })
          .max(200)
          .nullable()
          .optional(),
        tradeLicenseNo: str(60),
        rehabMemberNo: str(60),
        logoMediaId: zid.nullable().optional(),
        settings: z
          .object({
            defaultLocale: z.enum(['bn', 'en']).optional(),
            fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const patch = { ...req.valid.body };
    if (patch.phone) {
      patch.phone = normalizeBdPhone(patch.phone);
      if (!patch.phone)
        throw new BadRequestError('Invalid Bangladesh mobile number', { code: 'INVALID_PHONE' });
    }
    const { org, diff } = await updateOrg(req.orgId, patch);
    if (diff)
      await audit(auditContext(req), 'org.update', {
        entity: { type: 'Organization', id: org._id },
        diff,
      });
    ok(res, toPublicOrg(org));
  },
);

export default router;
