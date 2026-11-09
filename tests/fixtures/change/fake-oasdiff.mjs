#!/usr/bin/env node
// Fake oasdiff for unit tests: FAKE_OASDIFF_VERSION for `--version`, FAKE_OASDIFF_CHANGELOG (a JSON file) for `changelog`.
import { readFileSync } from 'node:fs';

const [cmd] = process.argv.slice(2);
if (cmd === '--version' || cmd === 'version') {
  process.stdout.write(process.env.FAKE_OASDIFF_VERSION === 'garbage' ? 'something odd\n' : `oasdiff version ${process.env.FAKE_OASDIFF_VERSION ?? '1.34.1'}\n`);
} else if (cmd === 'changelog') {
  const file = process.env.FAKE_OASDIFF_CHANGELOG;
  process.stdout.write(file ? readFileSync(file, 'utf8') : '[]');
} else {
  process.stderr.write(`fake oasdiff: unknown command ${cmd}\n`);
  process.exit(1);
}
