// Registers every job handler. Imported once by app.js so enqueue() knows all job types
// even when the scheduler isn't running (tests, scripts).
import './handlers/email.send.js';
import './handlers/media.purgeDeleted.js';
import './handlers/units.expireHolds.js';
import './handlers/frontend.revalidate.js';
import './handlers/leads.taskReminders.js';
import './handlers/leads.slaEscalation.js';
import './handlers/sms.send.js';
import './handlers/meta.fetchLead.js';
import './handlers/meta.reconcile.js';
import './handlers/documents.emailReceipt.js';

export { enqueue, nudge, startScheduler, stopScheduler, tick } from './scheduler.js';
