import { MongoBinary } from 'mongodb-memory-server';

// Runs once before any test file, with no hook timeout. On a fresh machine this downloads the
// MongoDB binary (~70 MB+, cached afterwards) so no individual test hook times out waiting for it.
export default async function globalSetup() {
  const path = await MongoBinary.getPath();
  if (!path) throw new Error('Could not obtain a MongoDB binary for tests');
}
