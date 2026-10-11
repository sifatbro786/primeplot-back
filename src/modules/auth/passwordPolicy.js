import { z } from 'zod';
import { PASSWORD_MAX, PASSWORD_MIN } from '#shared/crypto/password.js';
import { ValidationError } from '#shared/errors/AppError.js';

/** Length-first policy (NIST 800-63B): long passphrases beat composition rules. */
export const zPassword = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters`);

const COMMON = new Set([
  'password123',
  'password1234',
  '1234567890',
  '12345678910',
  'qwertyuiop',
  'qwerty12345',
  'iloveyou123',
  'admin12345',
  'administrator',
  'bangladesh1',
  'bangladesh123',
  'primeplot123',
  'abcdefghij',
  'letmein1234',
  'welcome123',
]);

/** Context checks that need the user (call after zPassword). Throws 422. */
export function assertPasswordAllowed(password, { email, name } = {}) {
  const lower = password.toLowerCase();
  const problems = [];
  if (COMMON.has(lower)) problems.push('This password is too common');
  if (/^(.)\1+$/.test(password)) problems.push('Password cannot be one repeated character');
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) {
    problems.push('Password cannot contain your email address');
  }
  const first = name?.trim().split(/\s+/)[0]?.toLowerCase();
  if (first && first.length >= 4 && lower.includes(first)) {
    problems.push('Password cannot contain your name');
  }
  if (problems.length) {
    throw new ValidationError(
      problems.map((message) => ({ path: 'password', message, code: 'weak_password' })),
    );
  }
}
