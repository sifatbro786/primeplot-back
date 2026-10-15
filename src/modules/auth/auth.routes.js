import { Router } from 'express';
import { z } from 'zod';
import { limits } from '#shared/middleware/rateLimit.js';
import { validate, zemail, zid } from '#shared/middleware/validate.js';
import { PASSWORD_MAX } from '#shared/crypto/password.js';
import { authenticate } from './auth.middleware.js';
import { TOKEN_PURPOSES } from './authToken.model.js';
import { zPassword } from './passwordPolicy.js';
import * as c from './auth.controller.js';

const router = Router();

// Login takes any string up to the max: policy is enforced when passwords are SET, and a
// tightened policy must never lock existing users out.
const loginPassword = z.string().min(1).max(PASSWORD_MAX);
const token = z.string().min(20).max(100);
// B5: e-mail OR phone. `email` stays for existing clients of the API; `identifier` takes either.
const identifier = z.string().trim().min(3).max(254);
const needsOne = (b) => Boolean(b.email || b.identifier);
const oneOf = { message: 'Enter your e-mail or mobile number', path: ['identifier'] };

router.post(
  '/login',
  limits.loginIp,
  limits.loginAccount,
  validate({
    body: z
      .object({
        email: zemail.optional(),
        identifier: identifier.optional(),
        password: loginPassword,
        remember: z.boolean().default(false),
      })
      .strict()
      .refine(needsOne, oneOf),
  }),
  c.login,
);
router.post('/refresh', limits.refresh, c.refresh);

// Logout works even with an expired access token (falls back to the refresh cookie).
router.post('/logout', optionalAuth, c.logout);
router.post('/logout-all', authenticate, c.logoutAll);

router.get('/me', authenticate, c.me);
router.post('/socket-token', authenticate, limits.refresh, c.socketToken);
router.patch(
  '/me',
  authenticate,
  validate({
    body: {
      name: z.string().trim().min(2).max(120).optional(),
      phone: z.string().trim().max(20).nullable().optional(),
      locale: z.enum(['bn', 'en']).optional(),
    },
  }),
  c.updateMe,
);

router.post(
  '/password/forgot',
  limits.sensitive,
  validate({
    body: z
      .object({ email: zemail.optional(), identifier: identifier.optional() })
      .strict()
      .refine(needsOne, oneOf),
  }),
  c.forgotPassword,
);
router.post(
  '/token/inspect',
  limits.sensitive,
  validate({ body: { token, purpose: z.enum(TOKEN_PURPOSES) } }),
  c.inspectToken,
);
router.post(
  '/password/reset',
  limits.sensitive,
  validate({ body: { token, password: zPassword } }),
  c.resetPassword,
);
router.post(
  '/setup-account',
  limits.sensitive,
  validate({ body: { token, password: zPassword } }),
  c.setupAccount,
);
router.post(
  '/password/change',
  authenticate,
  limits.sensitive,
  validate({ body: { currentPassword: loginPassword, newPassword: zPassword } }),
  c.changePassword,
);

router.get('/sessions', authenticate, c.sessions);
router.delete('/sessions/:id', authenticate, validate({ params: { id: zid } }), c.revokeMySession);

/** authenticate() if a token is present; anonymous otherwise (never 401). */
async function optionalAuth(req, res, next) {
  try {
    await authenticate(req, res, () => {});
  } catch {
    req.user = undefined;
  }
  next();
}

export default router;
