import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

/**
 * Single-use emailed tokens: password reset, account setup (staff invite / client portal
 * activation). Only the HMAC of the token is stored. Issuing a new token for the same
 * user+purpose invalidates the previous one.
 */
export const TOKEN_PURPOSES = Object.freeze(['password_reset', 'account_setup']);

const authTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: TOKEN_PURPOSES, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    ip: { type: String, default: null },
  },
  { collection: 'auth_tokens' },
);

authTokenSchema.plugin(baseSchema, { softDelete: false });
authTokenSchema.index({ orgId: 1, tokenHash: 1 }, { unique: true });
authTokenSchema.index({ orgId: 1, userId: 1, purpose: 1 });
// Keep a day past expiry for support/debugging, then drop.
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });

export const AuthToken = mongoose.model('AuthToken', authTokenSchema);
