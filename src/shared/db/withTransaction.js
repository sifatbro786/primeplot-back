import mongoose from 'mongoose';

/**
 * Run `fn(session)` inside a MongoDB transaction.
 *
 * - Retries automatically on TransientTransactionError / UnknownTransactionCommitResult
 *   (driver's withTransaction semantics, via Mongoose's connection.transaction()).
 * - Mongoose resets document state ($isNew, versions) if the transaction aborts, so a retried
 *   `fn` sees clean documents.
 * - Pass `session` to EVERY operation inside: Model.create([doc], { session }),
 *   query.session(session), doc.save({ session }). Operations without it run outside the
 *   transaction — the most common transaction bug.
 *
 * Keep `fn` free of side effects that can't be repeated (emails, SMS, HTTP calls): it may run
 * more than once. Queue those as jobs after the transaction commits.
 *
 *   const receipt = await withTransaction(async (session) => { ...; return receipt; });
 */
export function withTransaction(fn, options = {}) {
  return mongoose.connection.transaction(fn, {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
    ...options,
  });
}
