import { hashPassword } from '#shared/crypto/password.js';
import { Organization } from '#modules/organizations/organization.model.js';
import { invalidateOrgCache } from '#modules/organizations/organization.service.js';
import { User } from '#modules/users/user.model.js';
import { _resetAuthState } from '#modules/auth/authState.js';

export const PASSWORD = 'correct-horse-battery';
export const ORIGIN = 'http://localhost:3000';

export async function createOrg(overrides = {}) {
  invalidateOrgCache();
  _resetAuthState();
  return Organization.create({ name: 'Acme Properties', slug: 'acme', ...overrides });
}

let n = 0;
export async function createUser(
  org,
  { role = 'admin', status = 'active', password = PASSWORD, ...rest } = {},
) {
  n += 1;
  return User.create({
    orgId: org._id,
    name: `User ${n}`,
    email: `user${n}@example.com`,
    role,
    status,
    passwordHash: password ? await hashPassword(password) : null,
    ...rest,
  });
}

/** Log in through the API with a cookie-keeping agent. */
export async function loginAgent(request, app, user, password = PASSWORD) {
  const agent = request.agent(app).set('Origin', ORIGIN);
  const res = await agent
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .send({ email: user.email, password });
  if (res.status !== 200)
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

/** Pull a cookie value out of a Set-Cookie header array. */
export function cookieValue(res, name) {
  const raw = [].concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
  return raw ? decodeURIComponent(raw.split(';')[0].slice(name.length + 1)) : undefined;
}
