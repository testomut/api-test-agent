#!/usr/bin/env node
// Thin launcher so `npx api-test-agent` works without a build step.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
