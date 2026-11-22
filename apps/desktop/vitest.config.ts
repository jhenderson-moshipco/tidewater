import { defineConfig, mergeConfig } from 'vitest/config';
import vite_config from './vite.config.ts';

export default mergeConfig(
  vite_config,
  defineConfig({
    test: {
      environment: 'happy-dom',
      setupFiles: ['./src/testing/setup.ts'],
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/generated/**', 'src/testing/**', 'src/**/*.test.{ts,tsx}'],
        thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
    },
  }),
);
