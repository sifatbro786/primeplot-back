import mongoose from 'mongoose';
import { baseSchema } from '#shared/plugins/baseSchema.js';

/**
 * Document-number counters (ARCHITECTURE §5): one document per sequence, e.g.
 *   receipt:<projectId>:<fyStartYear>   booking:<projectId>   customer
 * The increment runs INSIDE the money transaction, so an aborted booking/receipt rolls its number
 * back — numbers stay gapless.
 */
const counterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, maxlength: 120 },
    seq: { type: Number, default: 0 },
  },
  { collection: 'counters' },
);

counterSchema.plugin(baseSchema, { softDelete: false });
counterSchema.index({ orgId: 1, key: 1 }, { unique: true });

export const Counter = mongoose.model('Counter', counterSchema);

/**
 * Make sure the counter exists BEFORE the transaction: two transactions inserting the same new
 * counter would fail with a duplicate key (not retryable); two incrementing an existing one get a
 * write conflict, which withTransaction() retries.
 */
export async function ensureCounter(orgId, key) {
  try {
    await Counter.updateOne({ orgId, key }, { $setOnInsert: { seq: 0 } }, { upsert: true });
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
}

/** Next number of a sequence. Call inside the transaction (pass its session). */
export async function nextSeq(orgId, key, { session }) {
  const c = await Counter.findOneAndUpdate(
    { orgId, key },
    { $inc: { seq: 1 } },
    { returnDocument: 'after', upsert: true, lean: true, session },
  );
  return c.seq;
}
