import { Router } from 'express';
import { z } from 'zod';
import { P, ROLES } from '#shared/auth/permissions.js';
import { validate, zemail, zid } from '#shared/middleware/validate.js';
import { created, noContent, ok } from '#shared/utils/response.js';
import { offsetQuery } from '#shared/utils/pagination.js';
import { authenticate, authorize } from '#modules/auth/auth.middleware.js';
import { auditContext } from '#modules/audit/audit.service.js';
import * as users from './user.service.js';

const router = Router();
router.use(authenticate);

const name = z.string().trim().min(2).max(120);
const phone = z.string().trim().max(20);

router.get(
  '/',
  authorize(P.USERS_READ),
  validate({
    query: {
      q: z.string().trim().min(1).max(100).optional(),
      role: z.enum(ROLES).optional(),
      status: z.enum(['invited', 'active', 'disabled']).optional(),
      ...offsetQuery,
    },
  }),
  async (req, res) => {
    const { items, meta } = await users.listUsers(req.orgId, req.valid.query);
    ok(res, items, { meta });
  },
);

router.get('/:id', authorize(P.USERS_READ), validate({ params: { id: zid } }), async (req, res) => {
  ok(res, users.toPublicUser(await users.getUser(req.orgId, req.valid.params.id)));
});

router.post(
  '/',
  authorize(P.USERS_MANAGE),
  validate({
    body: {
      name,
      email: zemail,
      phone: phone.optional(),
      role: z.enum(ROLES),
      locale: z.enum(['bn', 'en']).optional(),
    },
  }),
  async (req, res) => {
    const user = await users.createUser({
      org: req.org,
      input: req.valid.body,
      ctx: auditContext(req),
    });
    created(res, users.toPublicUser(user));
  },
);

router.patch(
  '/:id',
  authorize(P.USERS_MANAGE),
  validate({
    params: { id: zid },
    body: z
      .object({
        name: name.optional(),
        phone: phone.nullable().optional(),
        role: z.enum(ROLES).optional(),
        status: z.enum(['active', 'disabled']).optional(),
        locale: z.enum(['bn', 'en']).optional(),
      })
      .strict()
      .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
  }),
  async (req, res) => {
    const user = await users.updateUser({
      orgId: req.orgId,
      id: req.valid.params.id,
      patch: req.valid.body,
      ctx: auditContext(req),
    });
    ok(res, users.toPublicUser(user));
  },
);

router.post(
  '/:id/resend-invite',
  authorize(P.USERS_MANAGE),
  validate({ params: { id: zid } }),
  async (req, res) => {
    await users.resendInvite({ org: req.org, id: req.valid.params.id, ctx: auditContext(req) });
    noContent(res);
  },
);

export default router;
