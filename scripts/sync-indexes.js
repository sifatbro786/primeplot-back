// Bring the database's indexes in line with the models (run once after an upgrade):
//
//   npm run db:indexes
//
// B5 changed `users.email` to a PARTIAL unique index (portal clients may have no e-mail);
// MongoDB keeps the old index until it is replaced, so client logins without an e-mail would
// fail with a duplicate-key error. syncIndexes() drops indexes that differ and builds the new
// ones. Safe to re-run. Production: run it during a quiet minute (index builds take locks).
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '#config/db.js';
import '#jobs/index.js';
import '../src/app.js'; // registers every model

await connectDB();
const names = mongoose.modelNames().sort();
let changed = 0;
for (const name of names) {
  const model = mongoose.model(name);
  try {
    const dropped = await model.syncIndexes();
    if (dropped.length) {
      changed += dropped.length;
      console.log(`  ↻ ${name}: replaced ${dropped.join(', ')}`);
    } else console.log(`  ✔ ${name}`);
  } catch (err) {
    console.log(`  ✘ ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${names.length} models checked, ${changed} index(es) replaced.\n`);
await disconnectDB();
