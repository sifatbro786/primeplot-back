import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';
import { ROLES } from '#shared/auth/permissions.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    // Staff always have one (validated at the route); clients may sign in with the phone only (B5).
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: null },
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
    // B5: role 'client' → the buyer profile this login belongs to (customer.portalUserId mirrors it).
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  },
  { collection: 'users' },
);

userSchema.plugin(baseSchema);

// Users are never hard-deleted (audit trail) — they are disabled — so a unique index is safe.
// Partial (B5): portal clients without an e-mail address have email = null.
// Existing databases: run `npm run db:indexes` once (replaces the old non-partial index).
userSchema.index(
  { orgId: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
userSchema.index(
  { orgId: 1, customerId: 1 },
  { partialFilterExpression: { customerId: { $type: 'objectId' } } },
);
userSchema.index({ orgId: 1, role: 1, status: 1 });
userSchema.index(
  { orgId: 1, phone: 1 },
  { partialFilterExpression: { phone: { $type: 'string' } } },
);

export const User = mongoose.model('User', userSchema);
