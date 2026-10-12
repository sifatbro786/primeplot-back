import { sendRevalidation } from '#integrations/revalidate/index.js';
import { defineJob, PermanentJobError } from '../registry.js';

defineJob({
  type: 'frontend.revalidate',
  maxAttempts: 4, // ~4 min of retries; a missed revalidation only means a page refreshes later
  timeoutMs: 15_000,
  async handler({ tags }, { signal }) {
    if (!Array.isArray(tags) || !tags.length) throw new PermanentJobError('No tags');
    return sendRevalidation(tags, { signal });
  },
});
