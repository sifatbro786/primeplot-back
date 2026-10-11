import { purgeDeletedMedia } from '#modules/media/media.service.js';
import { defineJob } from '../registry.js';

defineJob({
  type: 'media.purgeDeleted',
  everyMs: 6 * 3_600_000, // every 6 hours, per org
  timeoutMs: 5 * 60_000,
  maxAttempts: 3,
  handler: (_payload, { orgId }) => purgeDeletedMedia(orgId),
});
