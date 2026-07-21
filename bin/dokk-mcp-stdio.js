#!/usr/bin/env node
// Thin launcher so the package's `bin` entry works without a build step:
// delegate to `tsx` to run the TypeScript entrypoint directly.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../src/transport/stdio.ts');
const result = spawnSync('npx', ['tsx', entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
