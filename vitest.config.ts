import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://ops:ops@localhost:5432/ops_test',
      JWT_SECRET: 'test-secret',
    },
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
