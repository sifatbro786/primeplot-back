import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

/**
 * One document per login session (= refresh-token family).
 * The refresh token is `<sessionId>.<secret>`; only an HMAC of the secret is stored.
 * Rotation swaps tokenHash atomically; presenting any older secret (outside a short grace
 * window for concurrent tabs) is treated as theft and revokes the session.
 */
const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true },
    prevTokenHash: { type: String, default: null },
    rotatedAt: { type: Date, default: null },
    remember: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true }, // sliding (idle) expiry
    absoluteExpiresAt: { type: Date, required: true }, // hard cap
    lastUsedAt: { type: Date, default: Date.now },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null, maxlength: 400 },
    revokedAt: { type: Date, default: null },
    revokedReason: {
      type: String,
      enum: [
        null,
        'logout',
        'logout_all',
        'reuse_detected',
        'password_changed',
        'admin',
        'user_disabled',
        'revoked_by_user',
      ],
      default: null,
    },
    // TTL purge — a week after the session can no longer be used.
    purgeAt: { type: Date, required: true },
  },
  { collection: 'sessions' },
);

sessionSchema.plugin(baseSchema, { softDelete: false });
sessionSchema.index({ orgId: 1, userId: 1, revokedAt: 1 });
sessionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model('Session', sessionSchema);
