// Registers every job handler. Imported once by app.js so enqueue() knows all job types
// even when the scheduler isn't running (tests, scripts).
import './handlers/email.send.js';
import './handlers/media.purgeDeleted.js';

export { enqueue, nudge, startScheduler, stopScheduler, tick } from './scheduler.js';
