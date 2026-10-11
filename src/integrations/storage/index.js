import { env } from '#config/env.js';
import { createLocalDriver } from './local.driver.js';

/**
 * Storage adapter (ARCHITECTURE §6.4). Modules call ONLY this — never fs or a vendor SDK.
 * The DB stores { driver, key, visibility }; URLs are built at read time, so moving to an
 * S3-compatible driver (R2/Spaces) later is a driver + data copy, not a schema change.
 *
 *   storage.put({ key, body, visibility: 'public' | 'private' })
 *   storage.remove({ key, visibility })
 *   storage.publicUrl(key)                  // public files only
 *   storage.createReadStream({ key, visibility })
 */
function createDriver() {
  switch (env.STORAGE_DRIVER) {
    case 'local':
      return createLocalDriver({ root: env.UPLOAD_DIR });
    default:
      throw new Error(`Unsupported STORAGE_DRIVER: ${env.STORAGE_DRIVER}`);
  }
}

const driver = createDriver();

export const storage = {
  driver: driver.name,
  put: (args) => driver.put(args),
  remove: (args) => driver.remove(args),
  stat: (args) => driver.stat(args),
  createReadStream: (args) => driver.createReadStream(args),
  publicUrl: (key) => `${env.mediaBaseUrl}/${key}`,
  /** Local driver only: directory to serve at /uploads in dev. */
  localPublicDir: driver.publicDir,
};
