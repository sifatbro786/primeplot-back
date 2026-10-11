import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

// Drop unknown filter paths. NoSQL-operator injection is blocked at the boundary instead:
// Express 5's "simple" query parser yields only strings, and every body/query goes through a
// Zod schema that accepts primitives only. (Global `sanitizeFilter` would force every internal
// `$in`/`$gte` through mongoose.trusted() — too easy to get wrong, so it stays off.)
mongoose.set('strictQuery', true);
// Indexes are built by a migration/sync script in production, not on every boot.
mongoose.set('autoIndex', !env.isProd);

const log = logger.child({ module: 'db' });

let listenersAttached = false;
function attachListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  const c = mongoose.connection;
  c.on('connected', () => log.info({ db: c.name }, 'MongoDB connected'));
  c.on('disconnected', () => log.warn('MongoDB disconnected'));
  c.on('reconnected', () => log.info('MongoDB reconnected'));
  // Log name/message only — the driver attaches the whole topology description.
  c.on('error', (err) =>
    log.error({ err: { name: err.name, message: err.message } }, 'MongoDB error'),
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Connect with bounded retries (Atlas M0 can be slow to accept the first connection).
 * After the initial connect, the driver handles reconnection itself.
 */
export async function connectDB({ retries = 5 } = {}) {
  attachListeners();
  for (let attempt = 1; ; attempt++) {
    try {
      await mongoose.connect(env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10_000,
        maxPoolSize: 10,
      });
      return mongoose.connection;
    } catch (err) {
      if (attempt >= retries) {
        log.error({ err: { name: err.name, message: err.message } }, 'MongoDB connection failed');
        throw err;
      }
      const wait = Math.min(1000 * 2 ** (attempt - 1), 15_000);
      log.warn(`MongoDB connect attempt ${attempt} failed (${err.message}); retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
}

export async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

/** true when the driver reports connected and the server answers a ping. */
export async function isDBReady() {
  if (mongoose.connection.readyState !== 1) return false;
  try {
    await mongoose.connection.db.admin().ping();
    return true;
  } catch {
    return false;
  }
}
