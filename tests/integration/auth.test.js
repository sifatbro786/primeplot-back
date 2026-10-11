import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDb, stopDb, clearDb } from '../helpers/db.js';
import {
  createOrg,
  createUser,
  cookieValue,
  loginAgent,
  ORIGIN,
  PASSWORD,
} from '../helpers/factory.js';

let app;
let Session;
let Job;
let User;
let AuditLog;

beforeAll(async () => {
  await startDb();
  ({ createApp: app } = await import('../../src/app.js'));
  app = app();
  ({ Session } = await import('#modules/auth/session.model.js'));
  ({ Job } = await import('#jobs/job.model.js'));
  ({ User } = await import('#modules/users/user.model.js'));
  ({ AuditLog } = await import('#modules/audit/audit.model.js'));
});
afterAll(stopDb);

let org;
let admin;
beforeEach(async () => {
  await clearDb();
  org = await createOrg();
  admin = await createUser(org, { role: 'admin' });
});

const post = (path) => request(app).post(`/api/v1${path}`).set('Origin', ORIGIN);

describe('login', () => {
  it('sets HttpOnly cookies and returns the user with permissions', async () => {
    const res = await post('/auth/login').send({ email: admin.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ email: admin.email, role: 'admin' });
    expect(res.body.data.user.permissions).toContain('users:manage');
    expect(res.body.data.user.passwordHash).toBeUndefined();

    const cookies = [].concat(res.headers['set-cookie']);
    const at = cookies.find((c) => c.startsWith('pp_at='));
    const rt = cookies.find((c) => c.startsWith('pp_rt='));
    expect(at).toMatch(/HttpOnly/i);
    expect(at).toMatch(/SameSite=Lax/i);
    expect(at).not.toMatch(/Domain=/i);
    expect(rt).toMatch(/Path=\/api\/v1\/auth/);
    expect(rt).toMatch(/SameSite=Strict/i);
    expect(await AuditLog.countDocuments({ orgId: org._id, action: 'auth.login' })).toBe(1);
  });

  it('gives the same 401 for unknown email, wrong password and invited user', async () => {
    const invited = await createUser(org, { status: 'invited', password: null });
    for (const body of [
      { email: 'nobody@example.com', password: PASSWORD },
      { email: admin.email, password: 'wrong-password-1' },
      { email: invited.email, password: PASSWORD },
    ]) {
      const res = await post('/auth/login').send(body);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('rejects unknown body keys and operator injection', async () => {
    expect(
      (await post('/auth/login').send({ email: admin.email, password: PASSWORD, role: 'x' }))
        .status,
    ).toBe(422);
    expect(
      (await post('/auth/login').send({ email: { $ne: null }, password: PASSWORD })).status,
    ).toBe(422);
  });

  it('locks the account after 5 failures — even the right password is refused', async () => {
    for (let i = 0; i < 5; i++) {
      await post('/auth/login').send({ email: admin.email, password: 'wrong-password-1' });
    }
    const res = await post('/auth/login').send({ email: admin.email, password: PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(res.body.error.details.retryAfterSec).toBeGreaterThan(800);
    expect(await AuditLog.countDocuments({ orgId: org._id, action: 'auth.account_locked' })).toBe(
      1,
    );
  });

  it('only tells a disabled user they are disabled when the password is right', async () => {
    const u = await createUser(org, { role: 'sales_executive', status: 'disabled' });
    expect(
      (await post('/auth/login').send({ email: u.email, password: 'nope-nope-nope' })).status,
    ).toBe(401);
    const res = await post('/auth/login').send({ email: u.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('me / authenticate', () => {
  it('works with the cookie and returns org + feature flags', async () => {
    const agent = await loginAgent(request, app, admin);
    const res = await agent.get('/api/v1/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.data.org.slug).toBe('acme');
    expect(res.body.data.features).toHaveProperty('onlinePayment');
  });

  it('401 without a token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('blocks state-changing requests from a foreign Origin', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: admin.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BAD_ORIGIN');
  });
});

describe('refresh rotation', () => {
  async function login() {
    const res = await post('/auth/login').send({ email: admin.email, password: PASSWORD });
    return cookieValue(res, 'pp_rt');
  }
  const refresh = (rt) => post('/auth/refresh').set('Cookie', `pp_rt=${encodeURIComponent(rt)}`);

  it('rotates: new refresh token, same session', async () => {
    const rt1 = await login();
    const res = await refresh(rt1);
    expect(res.status).toBe(200);
    const rt2 = cookieValue(res, 'pp_rt');
    expect(rt2).toBeTruthy();
    expect(rt2).not.toBe(rt1);
    expect(rt2.split('.')[0]).toBe(rt1.split('.')[0]);
  });

  it('concurrent refresh with the same token: one wins, the other gets a retryable 409', async () => {
    const rt1 = await login();
    const [a, b] = await Promise.all([refresh(rt1), refresh(rt1)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('REFRESH_SUPERSEDED');
    expect(loser.headers['set-cookie']).toBeUndefined(); // cookies untouched
  });

  it('reuse of a rotated token after the grace window revokes the whole session', async () => {
    const rt1 = await login();
    const rt2 = cookieValue(await refresh(rt1), 'pp_rt');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    try {
      const stolen = await refresh(rt1);
      expect(stolen.status).toBe(401);
      expect(stolen.body.error.code).toBe('REFRESH_REUSED');
      // The legitimate holder is logged out too — the family is dead.
      const legit = await refresh(rt2);
      expect(legit.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
    const s = await Session.findOne({ orgId: org._id, _id: rt1.split('.')[0] }).lean();
    expect(s.revokedReason).toBe('reuse_detected');
  });

  it('rejects garbage and unknown tokens', async () => {
    expect((await refresh('garbage')).status).toBe(401);
    expect((await refresh(`64b000000000000000000001.${'a'.repeat(43)}`)).status).toBe(401);
    expect((await post('/auth/refresh')).status).toBe(401);
  });
});

describe('logout', () => {
  it('logout kills the access token immediately and the refresh token', async () => {
    const agent = await loginAgent(request, app, admin);
    const login = await agent.get('/api/v1/auth/me');
    expect(login.status).toBe(200);

    // Capture the access token before logout clears it from the agent's jar.
    const sessions = await Session.find({ orgId: org._id, userId: admin._id }).lean();
    expect(sessions).toHaveLength(1);
    const res = await agent.post('/api/v1/auth/logout');
    expect(res.status).toBe(204);
    const s = await Session.findOne({ orgId: org._id, _id: sessions[0]._id }).lean();
    expect(s.revokedReason).toBe('logout');
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('logout-all invalidates tokens on every device', async () => {
    const a1 = await loginAgent(request, app, admin);
    const a2 = await loginAgent(request, app, admin);
    expect((await a1.post('/api/v1/auth/logout-all')).status).toBe(204);
    const res = await a2.get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(['SESSION_INVALIDATED', 'SESSION_REVOKED']).toContain(res.body.error.code);
  });

  it('a user can list and revoke only their own sessions', async () => {
    const a1 = await loginAgent(request, app, admin);
    await loginAgent(request, app, admin);
    const other = await createUser(org, { role: 'sales_manager' });
    const otherAgent = await loginAgent(request, app, other);

    const list = await a1.get('/api/v1/auth/sessions');
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s) => s.current)).toHaveLength(1);

    const victim = list.body.data[0].id;
    expect((await otherAgent.delete(`/api/v1/auth/sessions/${victim}`)).status).toBe(404);
    expect(
      (await a1.delete(`/api/v1/auth/sessions/${list.body.data.find((s) => !s.current).id}`))
        .status,
    ).toBe(204);
  });
});

describe('password reset & account setup', () => {
  const tokenFromJob = async (template) => {
    const job = await Job.findOne({
      orgId: org._id,
      type: 'email.send',
      'payload.template': template,
    })
      .sort({ createdAt: -1 })
      .lean();
    return { job, token: new URL(job.payload.data.url).searchParams.get('token') };
  };

  it('forgot-password answers 202 either way and queues a sensitive email only for real users', async () => {
    expect((await post('/auth/password/forgot').send({ email: 'ghost@example.com' })).status).toBe(
      202,
    );
    expect(await Job.countDocuments({ orgId: org._id })).toBe(0);
    expect((await post('/auth/password/forgot').send({ email: admin.email })).status).toBe(202);
    const { job, token } = await tokenFromJob('password_reset');
    expect(job.sensitive).toBe(true);
    expect(token).toMatch(/^[\w-]{43}$/);
  });

  it('reset: weak password keeps the link alive; success revokes sessions; link is single-use', async () => {
    const agent = await loginAgent(request, app, admin);
    await post('/auth/password/forgot').send({ email: admin.email });
    const { token } = await tokenFromJob('password_reset');

    const inspect = await post('/auth/token/inspect').send({ token, purpose: 'password_reset' });
    expect(inspect.body.data.valid).toBe(true);
    expect(inspect.body.data.email).not.toBe(admin.email); // masked

    expect(
      (await post('/auth/password/reset').send({ token, password: 'password123' })).status,
    ).toBe(422);
    const ok = await post('/auth/password/reset').send({ token, password: 'brand-new-secret-77' });
    expect(ok.status).toBe(204);
    expect(
      (await post('/auth/password/reset').send({ token, password: 'brand-new-secret-88' })).body
        .error.code,
    ).toBe('INVALID_TOKEN');

    expect((await agent.get('/api/v1/auth/me')).status).toBe(401); // old session dead
    const login = await post('/auth/login').send({
      email: admin.email,
      password: 'brand-new-secret-77',
    });
    expect(login.status).toBe(200);
  });

  it('invited user activates through the setup link', async () => {
    const agent = await loginAgent(request, app, admin);
    const created = await agent.post('/api/v1/users').send({
      name: 'New Exec',
      email: 'exec@example.com',
      role: 'sales_executive',
      phone: '01712345678',
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'invited', phone: '+8801712345678' });

    const { token } = await tokenFromJob('account_setup');
    expect(
      (await post('/auth/setup-account').send({ token, password: 'river-lamp-07-tiger' })).status,
    ).toBe(204);
    const u = await User.findOne({ orgId: org._id, email: 'exec@example.com' }).lean();
    expect(u.status).toBe('active');
    expect(
      (
        await post('/auth/login').send({
          email: 'exec@example.com',
          password: 'river-lamp-07-tiger',
        })
      ).status,
    ).toBe(200);
  });

  it('change password keeps this session, kills the others', async () => {
    const here = await loginAgent(request, app, admin);
    const elsewhere = await loginAgent(request, app, admin);
    const wrong = await here
      .post('/api/v1/auth/password/change')
      .send({ currentPassword: 'nope-nope-nope', newPassword: 'another-good-one-1' });
    expect(wrong.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
    const res = await here
      .post('/api/v1/auth/password/change')
      .send({ currentPassword: PASSWORD, newPassword: 'another-good-one-1' });
    expect(res.status).toBe(204);
    expect((await here.get('/api/v1/auth/me')).status).toBe(200);
    expect((await elsewhere.get('/api/v1/auth/me')).status).toBe(401);
  });
});
