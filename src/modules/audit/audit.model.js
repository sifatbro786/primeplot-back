import mongoose from 'mongoose';
import { env } from '#config/env.js';
import { AppError } from '#shared/errors/AppError.js';
import { baseSchema } from '#shared/plugins/baseSchema.js';

const auditSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, maxlength: 80 }, // e.g. 'auth.login', 'user.update'
    actor: {
      // null for system jobs / anonymous (e.g. failed login for an unknown email)
      id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      role: { type: String, default: null },
      name: { type: String, default: null },
      kind: { type: String, enum: ['user', 'system', 'anonymous'], default: 'user' },
    },
    entity: {
      type: { type: String, default: null, maxlength: 40 }, // 'User', 'Organization', 'Media'…
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    diff: { type: mongoose.Schema.Types.Mixed, default: undefined },
    meta: { type: mongoose.Schema.Types.Mixed, default: undefined },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null, maxlength: 400 },
    requestId: { type: String, default: null },
  },
  { collection: 'audit_logs' },
);

auditSchema.plugin(baseSchema, { softDelete: false });
auditSchema.index({ orgId: 1, createdAt: -1, _id: -1 });
auditSchema.index({ orgId: 1, 'entity.type': 1, 'entity.id': 1, createdAt: -1 });
auditSchema.index({ orgId: 1, 'actor.id': 1, createdAt: -1 });
auditSchema.index({ orgId: 1, action: 1, createdAt: -1 });
// Atlas M0 is 512 MB — keep a bounded window (AUDIT_RETENTION_DAYS, default 1 year).
auditSchema.index({ createdAt: 1 }, { expireAfterSeconds: env.AUDIT_RETENTION_DAYS * 86_400 });

// Append-only: application code can never edit or delete history (TTL expiry is server-side).
const blocked = () => {
  throw new AppError('Audit log is append-only', { statusCode: 500, code: 'AUDIT_IMMUTABLE' });
};
auditSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'findOneAndReplace',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  blocked,
);

export const AuditLog = mongoose.model('AuditLog', auditSchema);
