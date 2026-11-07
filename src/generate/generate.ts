import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding, Operation, Status } from '../types.js';
import { resolvePointer, type LoadedSpec } from '../spec/loader.js';
import { operationPointer } from '../spec/catalog.js';
import { findChains, type CrudChain, type DepsFile } from './graph.js';
import { sampleFromSchema } from './sample.js';
import { CONTRACT_ASSERT, renderCrudTest, type ChainPlan } from './templates.js';

export interface GenerateOptions {
  outDir: string; // where tests go, e.g. tests/generated
  deps?: DepsFile;
  version: string;
}

export interface Scenario {
  name: string;
  status: Status;
  reason: string;
  operations: string[];
  file?: string;
}

export interface GenerateResult {
  files: string[];
  scenarios: Scenario[];
}

const here = dirname(fileURLToPath(import.meta.url));

function bodySchema(spec: LoadedSpec, op: Operation): any {
  const content = resolvePointer(spec.doc, `${operationPointer(op)}/requestBody`).node?.content ?? {};
  const key = Object.keys(content).find((k) => k.includes('json'));
  return key ? content[key].schema : undefined;
}

function plan(spec: LoadedSpec, chain: CrudChain): { ok: true; plan: ChainPlan } | { ok: false; reason: string } {
  const unresolvedParams = (op: Operation) => op.params.filter((p) => p.required && p.in !== 'header' && p.name !== chain.param && p.knownValue === undefined);
  for (const op of [chain.create, chain.read, chain.update, chain.delete].filter(Boolean) as Operation[]) {
    const miss = unresolvedParams(op);
    if (miss.length) return { ok: false, reason: `${op.key} needs ${miss.map((p) => `${p.in} "${p.name}"`).join(', ')} with no value in the spec or the dependency.` };
  }
  if (!chain.delete) {
    return { ok: false, reason: `No delete operation is linked, so created data could not be cleaned up. Confirm that leaving test data is acceptable, or link a delete operation.` };
  }
  if (!chain.create.responses.some((r) => /^2\d\d$/.test(r.status))) {
    return { ok: false, reason: `${chain.create.key} documents no concrete 2xx status to assert.` };
  }
  const createSchema = bodySchema(spec, chain.create);
  if (chain.create.requestBodyRequired && !createSchema) return { ok: false, reason: `${chain.create.key} requires a body but the spec has no JSON schema for it.` };
  const created = createSchema ? sampleFromSchema(spec.doc, createSchema) : { ok: true as const, value: undefined, sources: [] as string[] };
  if (!created.ok) return { ok: false, reason: `Cannot build a valid create payload: ${created.reason}` };

  let updatePayload: unknown;
  let updateSources: string[] = [];
  const assumptions: string[] = [];
  if (chain.update) {
    const s = bodySchema(spec, chain.update);
    const u = s ? sampleFromSchema(spec.doc, s) : undefined;
    if (u?.ok && u.value && typeof u.value === 'object' && Object.keys(u.value).length) {
      updatePayload = u.value;
      updateSources = u.sources;
      if (chain.read) assumptions.push(`after ${chain.update.operationId ?? chain.update.key}, ${chain.read.operationId ?? chain.read.key} returns the updated field values (${chain.update.method.toUpperCase()} semantics).`);
    } else {
      assumptions.push(`update step skipped: no example-backed payload for ${chain.update.key}${u && !u.ok ? ` (${u.reason})` : ''}.`);
    }
  }
  return { ok: true, plan: { chain, createPayload: created.value, createSources: created.sources, updatePayload, updateSources, assumptions } };
}

export async function generate(spec: LoadedSpec, ops: Operation[], o: GenerateOptions): Promise<GenerateResult> {
  const { chains, candidates } = findChains(spec.doc, ops, o.deps);
  const out = resolve(o.outDir);
  const support = join(out, '_support');
  const files: string[] = [];
  const scenarios: Scenario[] = [];

  for (const chain of chains) {
    const opsIn = [chain.create, chain.read, chain.update, chain.delete].filter(Boolean).map((x) => x!.key);
    const p = plan(spec, chain);
    if (!p.ok) {
      scenarios.push({ name: chain.name, status: 'BLOCKED', reason: p.reason, operations: opsIn });
      continue;
    }
    await mkdir(support, { recursive: true });
    const file = join(out, `${(chain.create.operationId ?? 'create').replace(/[^\w-]/g, '_')}.crud.spec.ts`);
    await writeFile(file, renderCrudTest(p.plan, { spec: spec.location, hash: spec.hash, version: o.version }));
    files.push(file);
    const note = p.plan.assumptions.length ? ` Assumptions for review: ${p.plan.assumptions.join(' ')}` : '';
    scenarios.push({ name: chain.name, status: 'NOT_RUN', reason: `Generated from ${chain.source}; not executed yet.${note}`, operations: opsIn, file });
  }
  for (const c of candidates) scenarios.push({ name: c.name, status: 'BLOCKED', reason: c.question, operations: c.operations });

  if (files.length) {
    // Self-contained support code: the generated suite runs without the agent installed.
    const validatorSrc = await readFile(join(here, '../contract/validator.ts'), 'utf8');
    await writeFile(join(support, 'contract.ts'), validatorSrc);
    await writeFile(join(support, 'contract-assert.ts'), CONTRACT_ASSERT);
    await writeFile(join(support, 'openapi.snapshot.ts'), `// Snapshot of ${spec.location} (hash ${spec.hash}). Regenerate when the spec changes.\nexport const spec: any = ${JSON.stringify(spec.doc, null, 2)};\n`);
    files.push(join(support, 'contract.ts'), join(support, 'contract-assert.ts'), join(support, 'openapi.snapshot.ts'));
  }
  return { files, scenarios };
}

/** Run the generated tests once. Assertions are never modified to get a green result. */
export async function runGenerated(result: GenerateResult, env: { baseUrl: string }, outDir: string): Promise<void> {
  const specs = result.scenarios.filter((s) => s.file);
  if (!specs.length) return;
  const jsonPath = resolve(outDir, 'playwright-results.json');
  await mkdir(dirname(jsonPath), { recursive: true });
  const cli = join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js');
  if (!existsSync(cli)) {
    for (const s of specs) s.reason = `${s.reason} Not run: @playwright/test is not installed in ${process.cwd()}.`;
    return;
  }
  const args = [cli, 'test', ...specs.map((s) => relative(process.cwd(), s.file!).replace(/\\/g, '/')), '--reporter=json', '--workers=1'];
  const stdout = await new Promise<string>((done) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, API_BASE_URL: env.baseUrl, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.stderr.resume();
    child.on('close', () => done(buf));
  });
  if (!existsSync(jsonPath)) {
    for (const s of specs) {
      s.status = 'TEST_FAILURE';
      s.reason = `Playwright produced no report. ${stdout.slice(-300)}`;
    }
    return;
  }
  const report = JSON.parse(await readFile(jsonPath, 'utf8'));
  const tests: { file: string; status: string; message: string }[] = [];
  const walk = (suite: any, file?: string) => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.[t.results.length - 1];
        tests.push({ file: f, status: last?.status ?? 'unknown', message: (last?.errors ?? []).map((e: any) => e.message ?? '').join('\n') });
      }
    }
    for (const s of suite.suites ?? []) walk(s, f);
  };
  for (const s of report.suites ?? []) walk(s);

  for (const s of specs) {
    const base = relative(process.cwd(), s.file!).replace(/\\/g, '/');
    const t = tests.find((x) => base.endsWith(x.file) || x.file?.endsWith(base.split('/').pop()!));
    if (!t) {
      s.status = 'TEST_FAILURE';
      s.reason = 'Test did not run (not found in the Playwright report).';
    } else if (t.status === 'passed') {
      s.status = 'PASS';
      s.reason = s.reason.replace('not executed yet.', 'executed and passed.');
    } else {
      const clean = t.message.replace(/\u001b\[[0-9;]*m/g, '');
      s.status = /CONTRACT_MISMATCH/.test(clean) ? 'CONTRACT_MISMATCH' : 'TEST_FAILURE';
      s.reason = `${s.status === 'CONTRACT_MISMATCH' ? 'API response broke the contract' : 'Test failed'}: ${clean.split('\n').find((l) => l.trim()) ?? t.status}`;
    }
  }
}

export function scenarioFindings(result: GenerateResult): Finding[] {
  const findings: Finding[] = [];
  for (const s of result.scenarios) {
    for (const op of s.operations) {
      // An operation that is BLOCKED in one scenario but generated in another keeps the better record.
      const existing = findings.find((f) => f.operation === op);
      if (existing && existing.status !== 'BLOCKED') continue;
      if (existing) findings.splice(findings.indexOf(existing), 1);
      findings.push({ operation: op, source: 'generate', status: s.status, reason: `${s.name}: ${s.reason}` });
    }
  }
  return findings;
}
