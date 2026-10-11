import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

export const JOB_STATUS = Object.freeze(['queued', 'running', 'succeeded', 'dead']);

const jobSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, maxlength: 80 },
    payload: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    status: { type: String, enum: JOB_STATUS, default: 'queued' },
    priority: { type: Number, default: 0 },
    runAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    lockedUntil: { type: Date, default: null },
    lockedBy: { type: String, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 2000 },
    // Present only while the job is queued/running → at most one live job per key.
    dedupeKey: { type: String },
    // Payload holds a secret (e.g. a reset link) → wiped once the job finishes.
    sensitive: { type: Boolean, default: false },
    expireAt: { type: Date, default: null }, // TTL cleanup of finished jobs (M0 is 512 MB)
  },
  { collection: 'jobs', minimize: false },
);

jobSchema.plugin(baseSchema, { softDelete: false });
jobSchema.index({ status: 1, priority: -1, runAt: 1 }); // claim
jobSchema.index({ status: 1, lockedUntil: 1 }); // stale-lock recovery
jobSchema.index(
  { orgId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $exists: true } } },
);
jobSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const Job = mongoose.model('Job', jobSchema);
