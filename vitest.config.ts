import { defineConfig } from 'vitest/config';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@parser': resolve(__dirname, 'src/parser'),
      '@resolver': resolve(__dirname, 'src/resolver'),
      '@assertions': resolve(__dirname, 'src/assertions'),
      '@cli': resolve(__dirname, 'src/cli'),
      '@storage': resolve(__dirname, 'src/storage'),
      '@secrets': resolve(__dirname, 'src/secrets'),
      '@runner': resolve(__dirname, 'src/runner'),
      '@ipc': resolve(__dirname, 'src/ipc'),
      '@app': resolve(__dirname, 'src/app'),
      '@ui': resolve(__dirname, 'src/ui'),
      '@importer': resolve(__dirname, 'src/importer'),
      '@telemetry': resolve(__dirname, 'src/telemetry'),
      '@workspace-fs': resolve(__dirname, 'src/workspace-fs'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
