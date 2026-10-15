import { reconcilePayments } from '#modules/payments/payment.service.js';
import { defineJob } from '../registry.js';

// B5.2: SSLCommerz attempts that never came back (no IPN, browser closed) are looked up by
// tran_id; VALID ones get their receipt, abandoned ones expire. No store keys → nothing to do.
defineJob({
  type: 'payments.reconcile',
  everyMs: 10 * 60_000, // per org
  timeoutMs: 5 * 60_000,
  maxAttempts: 2,
  handler: (_payload, { orgId }) => reconcilePayments(orgId),
});
