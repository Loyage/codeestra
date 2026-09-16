import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/domain/**/*.test.ts'],
    environment: 'node',
  },
});
