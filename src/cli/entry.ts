// Bundle entry-point: the esbuild script targets this file, so this is the
// only place that owns process lifecycle. main.ts stays import-clean for tests.

import { main } from './main.js';

main(process.argv).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`coax: ${(err as Error).message}\n`);
    process.exit(3);
  },
);
