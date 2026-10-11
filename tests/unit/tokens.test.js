import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import { hashToken, randomToken, safeEqual } from '#shared/crypto/secrets.js';
import { signAccessToken, verifyAccessToken } from '#modules/auth/token.service.js';

const user = {
  _id: '64b000000000000000000001',
  orgId: '64b0000000000000000000aa',
  role: 'admin',
  authVersion: 3,
};

describe('access tokens', () => {
  it('round-trips claims', () => {
    const t = signAccessToken({ user, sessionId: '64b0000000000000000000ff' });
    const c = verifyAccessToken(t);
    expect(c).toMatchObject({
      sub: user._id,
      org: user.orgId,
      role: 'admin',
      av: 3,
      sid: '64b0000000000000000000ff',
    });
    expect(c.exp - c.iat).toBe(15 * 60);
  });

  it('rejects tampered, foreign-key and alg:none tokens', () => {
    const t = signAccessToken({ user, sessionId: 'x' });
    const [h, p, s] = t.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), role: 'x' }),
    ).toString('base64url');
    expect(() => verifyAccessToken(`${h}.${forged}.${s}`)).toThrow();
    expect(() =>
      verifyAccessToken(jwt.sign({ sub: '1' }, 'other-secret-other-secret-other-secret')),
    ).toThrow();
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    expect(() => verifyAccessToken(none)).toThrow();
  });

  it('reports expiry distinctly', () => {
    const t = signAccessToken({ user, sessionId: 'x' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    try {
      expect(() => verifyAccessToken(t)).toThrow(
        expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('secrets', () => {
  it('random tokens are 43-char base64url and hashes are keyed + stable', () => {
    const t = randomToken();
    expect(t).toMatch(/^[\w-]{43}$/);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(hashToken(randomToken()));
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
});
