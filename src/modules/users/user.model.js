import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';
import { ROLES } from '#shared/auth/permissions.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, default: null }, // E.164
    role: { type: String, enum: ROLES, required: true },
    // invited: account exists, password not set yet (setup link sent)
    status: { type: String, enum: ['invited', 'active', 'disabled'], default: 'invited' },
    locale: { type: String, enum: ['bn', 'en'], default: 'bn' },
    avatarMediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media', default: null },

    // ── Auth state (never serialized) ──
    passwordHash: { type: String, select: false, default: null },
    passwordChangedAt: { type: Date, select: false, default: null },
    // Bumped on password change / role change / disable / logout-all. Access tokens carry it,
    // so every outstanding token dies immediately.
    authVersion: { type: Number, default: 0 },
    failedLoginCount: { type: Number, select: false, default: 0 },
    lockCount: { type: Number, select: false, default: 0 },
    lockUntil: { type: Date, select: false, default: null },
    lastLoginAt: { type: Date, default: null },
    lastLoginIp: { type: String, select: false, default: null },

    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'users' },
);

userSchema.plugin(baseSchema);

// Users are never hard-deleted (audit trail) — they are disabled — so a plain unique index is safe.
userSchema.index({ orgId: 1, email: 1 }, { unique: true });
userSchema.index({ orgId: 1, role: 1, status: 1 });
userSchema.index(
  { orgId: 1, phone: 1 },
  { partialFilterExpression: { phone: { $type: 'string' } } },
);

export const User = mongoose.model('User', userSchema);
