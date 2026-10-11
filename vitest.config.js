import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/global-setup.js'],
    setupFiles: ['tests/setup-env.js'],
    // Integration files each start an in-memory replica set; run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000, // binary download happens in globalSetup, not here
  },
});
