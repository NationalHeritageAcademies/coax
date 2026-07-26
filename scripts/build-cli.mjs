// Bundles src/cli/main.ts into dist-cli/coax.cjs as a single-file Node executable.
// Targets Node 18+, format CJS so the bin shim works without ESM ceremony.

import { build } from 'esbuild';
import { chmod, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
// Build into the publishable subpackage so `npm publish` from packages/coax-cli
// picks up a fresh bundle without copying anything around.
const outFile = resolve(root, 'packages/coax-cli/coax.cjs');

await mkdir(resolve(root, 'packages/coax-cli'), { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/cli/entry.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: ['node18'],
  format: 'cjs',
  banner: { js: '#!/usr/bin/env node' },
  // commander, jsonpath-plus, undici — all pure JS, safe to bundle.
  // Path aliases mirror tsconfig + vitest config so imports resolve.
  alias: {
    '@parser': resolve(root, 'src/parser'),
    '@resolver': resolve(root, 'src/resolver'),
    '@assertions': resolve(root, 'src/assertions'),
    '@cli': resolve(root, 'src/cli'),
    '@runner': resolve(root, 'src/runner'),
    '@workspace-fs': resolve(root, 'src/workspace-fs'),
  },
  logLevel: 'info',
  legalComments: 'none',
});

await chmod(outFile, 0o755);
console.log(`coax CLI bundled → ${outFile}`);
