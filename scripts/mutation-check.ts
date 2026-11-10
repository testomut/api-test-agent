/**
 * Fault injection for the generated collection tests (docs/SUPPORT_MATRIX.md, "Defect detection").
 *
 * Starts the demo API once per fault mode (DEMO_FAULT) on its own port and runs the given generated test files:
 * without a fault every test must pass; with each fault at least one test must fail. A fault no test catches is a
 * hole in the generator, and the script exits 1.
 *
 *   npx tsx scripts/mutation-check.ts --lang typescript tests/api/items/get
 *   npx tsx scripts/mutation-check.ts --lang python tests/api-python/items/get
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findPython } from '../src/generate/generate.js';

export const FAULTS = ['ignore-filter', 'wrong-sort', 'hide-created', 'duplicate', 'wrong-field', 'bad-pagination', 'require-optional', 'accept-expired', 'ignore-suspension', 'ignore-max', 'loose-types', 'ignore-enum', 'wrong-total', 'drop-update', 'ignore-required', 'broken-search', 'truncate-decimal'] as const;

const args = process.argv.slice(2);
const lang = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'typescript';
const targets = args.filter((a, i) => !a.startsWith('--') && !['--lang', '--port', '--faults', '--label'].includes(args[i - 1]));
const basePort = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 3200);
/** --faults a,b: only these fault modes (each must be caught by the targets given). */
const only = args.includes('--faults') ? args[args.indexOf('--faults') + 1].split(',') : undefined;
if (!targets.length) {
  console.error('usage: mutation-check.ts [--lang typescript|python] [--port 3200] <generated test folder or file>...');
  process.exit(2);
}

async function waitHealthy(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url + '/health')).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`demo API at ${url} did not start`);
}

function runTests(baseUrl: string): { passed: number; failed: number; skipped: number; output: string; failedTests: string[] } {
  const env = { ...process.env, API_BASE_URL: baseUrl };
  if (lang === 'python') {
    const r = spawnSync(findPython(), ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...targets], { env, encoding: 'utf8' });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    const n = (word: string) => Number(out.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
    const failedTests = [...out.matchAll(/^(?:FAILED|ERROR) (\S+)/gm)].map((m) => m[1].split('::').slice(-1)[0]);
    return { passed: n('passed'), failed: n('failed') + n('error'), skipped: n('skipped'), output: out, failedTests };
  }
  const config = resolve('.mutation.playwright.config.mjs');
  writeFileSync(config, `export default { testDir: '.', testMatch: ${JSON.stringify(targets.map((t) => resolve(t).replace(/\\/g, '/') + (t.endsWith('.ts') ? '' : '/**/*.spec.ts')))}, retries: 0, workers: 4, use: { baseURL: ${JSON.stringify(baseUrl + '/')}, extraHTTPHeaders: { accept: 'application/json' } } };\n`);
  try {
    const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'test', '--config', config, '--reporter=json'], { env, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    const s = report.stats ?? {};
    const failedTests: string[] = [];
    const walk = (suite: any) => {
      for (const sp of suite.specs ?? []) for (const t of sp.tests ?? []) if (t.status === 'unexpected' || t.status === 'flaky') failedTests.push(`${(suite.file ?? '').split('\\').join('/').split('/').slice(-3, -1).join('/')}: ${sp.title}`);
      for (const c of suite.suites ?? []) walk(c);
    };
    for (const suite of report.suites ?? []) walk(suite);
    return { passed: s.expected ?? 0, failed: (s.unexpected ?? 0) + (s.flaky ?? 0), skipped: s.skipped ?? 0, output: r.stderr, failedTests };
  } finally {
    rmSync(config, { force: true });
  }
}

async function withServer<T>(fault: string, port: number, fn: (url: string) => T): Promise<T> {
  const env = { ...process.env, PORT: String(port), ...(fault ? { DEMO_FAULT: fault } : {}) };
  delete (env as any)[fault ? '' : 'DEMO_FAULT'];
  const child = spawn(process.execPath, ['--import', 'tsx', 'demo-api/server.ts'], { env, stdio: 'ignore' });
  const url = `http://localhost:${port}`;
  try {
    await waitHealthy(url);
    return fn(url);
  } finally {
    child.kill();
  }
}

const rows: { fault: string; passed: number; failed: number; skipped: number; ok: boolean; caughtBy: string[] }[] = [];
const faults = only ? FAULTS.filter((f) => only.includes(f)) : FAULTS;
if (only && faults.length !== only.length) throw new Error(`unknown fault in --faults ${only.join(',')}: known ${FAULTS.join(', ')}`);
for (const [i, fault] of ['', ...faults].entries()) {
  const r = await withServer(fault, basePort + i, runTests);
  const ok = fault ? r.failed > 0 : r.failed === 0 && r.passed > 0;
  rows.push({ fault: fault || '(none)', passed: r.passed, failed: r.failed, skipped: r.skipped, ok, caughtBy: r.failedTests });
  if (!fault && !ok) console.error(r.output.slice(-4000));
}
console.log(`\nFault injection (${lang}): ${targets.join(', ')}`);
console.log('fault            passed  failed  skipped  verdict');
for (const r of rows) console.log(`${r.fault.padEnd(16)} ${String(r.passed).padStart(6)}  ${String(r.failed).padStart(6)}  ${String(r.skipped).padStart(7)}  ${r.fault === '(none)' ? (r.ok ? 'clean' : 'FAILS WITHOUT A FAULT') : r.ok ? 'detected' : 'MISSED'}`);
if (args.includes('--show')) for (const r of rows.filter((x) => x.fault !== '(none)')) console.log(`  ${r.fault}: ${r.caughtBy.slice(0, 4).join(' | ') || '-'}`);
const detected = rows.filter((r) => r.fault !== '(none)' && r.ok).length;
console.log(`detected ${detected}/${faults.length} injected defects`);
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : lang;
if (existsSync('reports')) writeFileSync(`reports/mutation-${label}.json`, JSON.stringify({ lang, targets, rows, detected, injected: faults.length }, null, 2) + '\n');
process.exit(rows.every((r) => r.ok) ? 0 : 1);
