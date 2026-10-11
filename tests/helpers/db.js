import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let replSet;

/** Start a single-node replica set (transactions work) and connect mongoose to it. */
export async function startDb() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri('primeplot-test'));
  await mongoose.syncIndexes(); // unique/partial/TTL indexes must exist for the tests
}

export async function stopDb() {
  await mongoose.disconnect();
  await replSet?.stop();
}

/** Wipe data between tests via the raw driver (bypasses the tenant guard on purpose). */
export async function clearDb() {
  const cols = await mongoose.connection.db.collections();
  await Promise.all(cols.map((c) => c.deleteMany({})));
}
