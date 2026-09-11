import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: ['./test/helpers/setup-env.ts'],
    globalSetup: ['./test/helpers/global-setup.ts'],
    // Integration tests share one Postgres database, so they run serially.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
