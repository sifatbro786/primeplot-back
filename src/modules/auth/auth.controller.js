import { ok, noContent } from '#shared/utils/response.js';
import { integrationStatus } from '#integrations/config.js';
import { auditContext } from '#modules/audit/audit.service.js';
import { toPublicUser, updateOwnProfile, getUser } from '#modules/users/user.service.js';
import { toPublicOrg } from '#modules/organizations/organization.service.js';
import {
  clearAuthCookies,
  REFRESH_COOKIE,
  setAccessCookie,
  setAuthCookies,
} from './auth.cookies.js';
import * as authService from './auth.service.js';
import { listSessions, revokeSession } from './session.service.js';
import { NotFoundError } from '#shared/errors/AppError.js';
import { signSocketToken, SOCKET_TOKEN_TTL_SEC } from './token.service.js';

export async function login(req, res) {
  const { email, password, remember } = req.valid.body;
  const r = await authService.login({
    orgId: req.orgId,
    email,
    password,
    remember,
    ctx: auditContext(req),
  });
  setAuthCookies(res, r);
  ok(res, { user: toPublicUser(r.user, { withPermissions: true }) });
}

export async function refresh(req, res) {
  try {
    const r = await authService.refresh({
      orgId: req.orgId,
      refreshToken: req.cookies?.[REFRESH_COOKIE],
      ctx: auditContext(req),
    });
    setAuthCookies(res, r);
    ok(res, { user: toPublicUser(r.user, { withPermissions: true }) });
  } catch (err) {
    // A dead refresh token must not linger in the browser. (409 SUPERSEDED keeps cookies.)
    if (err?.statusCode === 401) clearAuthCookies(res);
    throw err;
  }
}

export async function logout(req, res) {
  await authService.logout({
    orgId: req.orgId,
    sessionId: req.user?.sessionId,
    refreshToken: req.cookies?.[REFRESH_COOKIE],
    ctx: auditContext(req),
  });
  clearAuthCookies(res);
  noContent(res);
}

export async function logoutAll(req, res) {
  await authService.logoutAll({ orgId: req.orgId, userId: req.user.id, ctx: auditContext(req) });
  clearAuthCookies(res);
  noContent(res);
}

export async function me(req, res) {
  const user = await getUser(req.orgId, req.user.id);
  ok(res, {
    user: toPublicUser(user, { withPermissions: true }),
    org: toPublicOrg(req.org),
    features: integrationStatus(req.orgId),
  });
}

export async function updateMe(req, res) {
  const user = await updateOwnProfile({
    orgId: req.orgId,
    userId: req.user.id,
    patch: req.valid.body,
    ctx: auditContext(req),
  });
  ok(res, { user: toPublicUser(user, { withPermissions: true }) });
}

export async function forgotPassword(req, res) {
  await authService.forgotPassword({
    org: req.org,
    email: req.valid.body.email,
    ctx: auditContext(req),
  });
  // Same answer whether or not the email exists.
  ok(
    res,
    { message: 'If an account exists for this email, a link has been sent.' },
    { status: 202 },
  );
}

export async function inspectToken(req, res) {
  ok(res, await authService.inspectToken({ orgId: req.orgId, ...req.valid.body }));
}

export async function resetPassword(req, res) {
  const { token, password } = req.valid.body;
  await authService.resetPassword({ org: req.org, token, password, ctx: auditContext(req) });
  clearAuthCookies(res);
  noContent(res);
}

export async function setupAccount(req, res) {
  const { token, password } = req.valid.body;
  await authService.setupAccount({ org: req.org, token, password, ctx: auditContext(req) });
  noContent(res);
}

export async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.valid.body;
  const { accessToken } = await authService.changePassword({
    org: req.org,
    userId: req.user.id,
    sessionId: req.user.sessionId,
    currentPassword,
    newPassword,
    ctx: auditContext(req),
  });
  setAccessCookie(res, accessToken);
  noContent(res);
}

export async function sessions(req, res) {
  ok(
    res,
    await listSessions({
      orgId: req.orgId,
      userId: req.user.id,
      currentSessionId: req.user.sessionId,
    }),
  );
}

export async function revokeMySession(req, res) {
  const done = await revokeSession({
    orgId: req.orgId,
    userId: req.user.id, // object-level check: only your own sessions
    sessionId: req.valid.params.id,
    reason: 'revoked_by_user',
  });
  if (!done) throw new NotFoundError('Session not found');
  if (req.valid.params.id === req.user.sessionId) clearAuthCookies(res);
  noContent(res);
}

/** Short-lived token for the Socket.IO handshake (B2 — see token.service.js). */
export function socketToken(req, res) {
  ok(res, {
    token: signSocketToken({ user: req.user, orgId: req.orgId }),
    expiresIn: SOCKET_TOKEN_TTL_SEC,
  });
}
