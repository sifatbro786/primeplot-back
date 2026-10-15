import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { env } from '#config/env.js';
import { TooManyRequestsError } from '#shared/errors/AppError.js';

/**
 * In-memory rate limiting (single PM2 instance — ARCHITECTURE §6.2). Counters reset on restart;
 * durable brute-force protection is the per-account lockout on the user document.
 * IPv6 clients are bucketed by /56 so one host can't rotate through its whole range.
 */
export function limiter({ windowMs, limit, key = 'ip', name }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    identifier: name,
    skip: () => env.isTest && !process.env.TEST_RATE_LIMIT,
    keyGenerator(req) {
      const ip = ipKeyGenerator(req.ip ?? '', 56);
      if (key === 'ip+email') {
        // B5: clients may sign in with a phone number (`identifier`) instead of an e-mail.
        const raw = req.body?.identifier ?? req.body?.email;
        const id = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[\s-]/g, '') : '';
        return `${ip}|${id.slice(0, 254)}`;
      }
      return ip;
    },
    handler(req, res, next, options) {
      res.setHeader('Retry-After', Math.ceil(options.windowMs / 1000));
      next(new TooManyRequestsError());
    },
  });
}

const MIN = 60_000;

export const limits = {
  /** Whole API: generous, stops scrapers and runaway clients. */
  api: limiter({ name: 'api', windowMs: MIN, limit: 300 }),
  /** Login: per IP and per IP+email (credential stuffing vs. targeted guessing). */
  loginIp: limiter({ name: 'login-ip', windowMs: 15 * MIN, limit: 50 }),
  loginAccount: limiter({ name: 'login-acct', windowMs: 15 * MIN, limit: 10, key: 'ip+email' }),
  refresh: limiter({ name: 'refresh', windowMs: MIN, limit: 30 }),
  /** Anything that sends an email or consumes a one-time token. */
  sensitive: limiter({ name: 'sensitive', windowMs: 15 * MIN, limit: 10 }),
  upload: limiter({ name: 'upload', windowMs: MIN, limit: 30 }),
  internal: limiter({ name: 'internal', windowMs: MIN, limit: 10 }),
};
