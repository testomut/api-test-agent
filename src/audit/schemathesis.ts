import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding, Operation } from '../types.js';
import type { OpenApiDoc } from '../spec/loader.js';
import { redact } from './auth.js';

export interface SchemathesisOptions {
  specLocation: string;
  baseUrl: string;
  outDir: string;
  allowWrite: boolean;
  maxExamples: number;
  maxTimeSec: number;
  requestsPerSecond: number;
  timeoutSec: number;
  seed: number;
  headers: Record<string, string>;
  binary?: string;
}

export interface SchemathesisRun {
  command: string; // redacted, safe to put in a report / CI file
  exitCode: number | null;
  findings: Finding[];
  junitPath?: string;
}

export function findSchemathesis(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const local = process.platform === 'win32' ? '.venv/Scripts/schemathesis.exe' : '.venv/bin/schemathesis';
  // The current folder's venv first, then the agent's own venv (when run from another repo).
  const agentRoot = fileURLToPath(new URL('../../', import.meta.url));
  for (const candidate of [resolve(local), join(agentRoot, local)]) if (existsSync(candidate)) return candidate;
  return 'schemathesis'; // on PATH; failure to spawn is reported as NOT_RUN
}

export async function runSchemathesis(doc: OpenApiDoc, ops: Operation[], o: SchemathesisOptions): Promise<SchemathesisRun> {
  const dir = resolve(o.outDir, 'schemathesis');
  await mkdir(dir, { recursive: true });
  const junitPath = join(dir, 'junit.xml');
  const jsonPath = join(dir, 'run.json');

  const args = [
    'run', o.specLocation,
    '--url', o.baseUrl,
    '--checks', 'all',
    '--max-examples', String(o.maxExamples),
    '--max-time', String(o.maxTimeSec),
    '--rate-limit', `${o.requestsPerSecond}/s`,
    '--request-timeout', String(o.timeoutSec),
    '--workers', '1',
    '--seed', String(o.seed),
    '--generation-database', 'none',
    '--report', 'junit,json',
    '--report-junit-path', junitPath,
    '--report-json-path', jsonPath,
    '--no-color',
  ];
  if (!o.allowWrite) args.push('--include-method', 'GET');
  for (const [k, v] of Object.entries(o.headers)) args.push('-H', `${k}: ${v}`);

  const bin = findSchemathesis(o.binary)!;
  const shown = (a: string) => (isAbsolute(a) ? relative(process.cwd(), a).replace(/\\/g, '/') || '.' : a);
  const command = redact(['schemathesis', ...args.map(shown)].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '));

  const exitCode = await new Promise<number | null>((done) => {
    const child = spawn(bin, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });

  const selected = o.allowWrite ? ops : ops.filter((op) => op.method === 'get');
  if (exitCode === null || !existsSync(jsonPath)) {
    const why = exitCode === null ? `Schemathesis could not be started (${bin}). Install it: python -m venv .venv && .venv/Scripts/pip install schemathesis` : `Schemathesis exited with ${exitCode} and wrote no report.`;
    return { command, exitCode, findings: ops.map((op) => ({ operation: op.key, source: 'schemathesis', status: 'NOT_RUN', reason: why })) };
  }

  const run = JSON.parse(await readFile(jsonPath, 'utf8'));
  const cases = existsSync(junitPath) ? parseJunit(await readFile(junitPath, 'utf8')) : new Map<string, JunitCase>();
  const missingData = new Set<string>(run.warnings?.missing_test_data ?? []);
  const missingAuth = new Set<string>(run.warnings?.missing_auth ?? []);

  const findings: Finding[] = ops.map((op) => {
    const base = { operation: op.key, source: 'schemathesis' as const };
    if (!selected.includes(op)) return { ...base, status: 'NOT_RUN', reason: 'Write methods are excluded (pass --allow-write for a test environment).' };
    const c = cases.get(op.key);
    if (!c) return { ...base, status: 'NOT_RUN', reason: 'Not executed by Schemathesis (time/budget limit or filtered).' };
    if (c.failure) {
      const codes = [...new Set(c.failure.match(/ST\d{3}/g) ?? [])];
      return { ...base, status: 'CONTRACT_MISMATCH', reason: `Schemathesis checks failed: ${codes.join(', ') || 'see details'}`, details: redact(truncate(c.failure, 1500)) };
    }
    if (c.error) return { ...base, status: 'TEST_FAILURE', reason: 'Schemathesis could not exercise this operation.', details: redact(truncate(c.error, 800)) };
    if (missingAuth.has(op.key)) return { ...base, status: 'BLOCKED', reason: 'Every request was rejected as unauthorized: provide credentials.' };
    if (missingData.has(op.key)) {
      return { ...base, status: 'BLOCKED', reason: 'Only 404 responses: no real identifiers, so the core logic was never reached. Not a PASS.' };
    }
    return { ...base, status: 'PASS', reason: `Generated cases passed all checks (seed ${o.seed}).` };
  });
  return { command, exitCode, findings, junitPath };
}

interface JunitCase {
  failure?: string;
  error?: string;
}

export function parseJunit(xml: string): Map<string, JunitCase> {
  const out = new Map<string, JunitCase>();
  const re = /<testcase\b[^>]*\bname="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const name = decodeXml(m[1]);
    const inner = m[2] ?? '';
    const failure = /<failure\b[^>]*>([\s\S]*?)<\/failure>/.exec(inner)?.[1];
    const error = /<error\b[^>]*>([\s\S]*?)<\/error>/.exec(inner)?.[1];
    out.set(name, { failure: failure && decodeXml(failure), error: error && decodeXml(error) });
  }
  return out;
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n…(truncated)' : s);
