import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '#shared/crypto/password.js';
import { assertPasswordAllowed, zPassword } from '#modules/auth/passwordPolicy.js';

describe('password hashing (scrypt)', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const h = await hashPassword('correct-horse-battery');
    expect(h).toMatch(/^scrypt\$15\$8\$3\$/);
    expect(await verifyPassword('correct-horse-battery', h)).toEqual({
      ok: true,
      needsRehash: false,
    });
    expect((await verifyPassword('correct-horse-batterY', h)).ok).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same-password-1')).not.toBe(await hashPassword('same-password-1'));
  });

  it('flags weaker legacy params for rehash', async () => {
    const h = await hashPassword('correct-horse-battery');
    const weaker = h.replace('scrypt$15$8$3$', 'scrypt$14$8$3$');
    // different params → different derived key → not ok; craft a real weaker hash instead
    const { scrypt } = await import('node:crypto');
    const salt = Buffer.from('0123456789abcdef');
    const key = await new Promise((r, j) =>
      scrypt('pw-legacy-12345', salt, 32, { N: 2 ** 14, r: 8, p: 1 }, (e, k) => (e ? j(e) : r(k))),
    );
    const legacy = `scrypt$14$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
    expect(await verifyPassword('pw-legacy-12345', legacy)).toEqual({
      ok: true,
      needsRehash: true,
    });
    expect((await verifyPassword('correct-horse-battery', weaker)).ok).toBe(false);
  });

  it('never accepts null/garbage hashes or oversized input', async () => {
    expect((await verifyPassword('x', null)).ok).toBe(false);
    expect((await verifyPassword('x', 'bcrypt$whatever')).ok).toBe(false);
    const h = await hashPassword('correct-horse-battery');
    expect((await verifyPassword('a'.repeat(129), h)).ok).toBe(false);
  });
});

describe('password policy', () => {
  it('enforces length', () => {
    expect(zPassword.safeParse('short').success).toBe(false);
    expect(zPassword.safeParse('long-enough-pass').success).toBe(true);
    expect(zPassword.safeParse('x'.repeat(129)).success).toBe(false);
  });

  it('rejects common, repeated, email- and name-based passwords', () => {
    const ctx = { email: 'sifat@example.com', name: 'Sifat Islam' };
    expect(() => assertPasswordAllowed('password123', ctx)).toThrow();
    expect(() => assertPasswordAllowed('aaaaaaaaaaaa', ctx)).toThrow();
    expect(() => assertPasswordAllowed('my-sifat-pass-1', ctx)).toThrow();
    expect(() => assertPasswordAllowed('river-lamp-07-tiger', ctx)).not.toThrow();
  });
});
