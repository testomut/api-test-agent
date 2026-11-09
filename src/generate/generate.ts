import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAFE_METHODS, type Finding, type Operation, type Status } from '../types.js';
import { resolvePointer, type LoadedSpec } from '../spec/loader.js';
import { operationPointer } from '../spec/catalog.js';
import { findChains, type CrudChain, type DepsFile } from './graph.js';
import { sampleFromSchema } from './sample.js';
import { bodyCases, documentedRejections, nonexistentIdExpr, queryCases } from './negative.js';
import { CONTRACT_ASSERT, SUITE_TYPES, TS_FILES, operationFolder, renderContract, renderFunctional, renderResourceHelpers, renderScenarios, scenarioCases, suiteCounts, type ChainPlan, type Meta, type SuiteInput, type SuiteType } from './templates.js';
import { API_BASE, buildApiIndex, renderApiBaseClass, renderApiChildClass, renderApis } from './api-objects.js';
import { PY_FILES, pyName, renderConftest, renderPyContract, renderPyFunctional, renderPyResource, renderPyScenarios, resourceModule } from './python.js';

const PY_RESERVED = new Set([
  'py', 'pytest', '_pytest', 'requests', 'jsonschema', 'contract', 'conftest',
  'json', 'typing', 'types', 'email', 'http', 'logging', 'string', 'random', 'queue', 'site', 'test',
  'unittest', 'os', 'sys', 're', 'io', 'collections', 'abc', 'ast', 'code', 'copy', 'select', 'signal',
  'socket', 'ssl', 'time', 'uuid', 'urllib', 'pathlib', 'enum', 'platform', 'inspect', 'operator',
]);

export type TestLang = 'typescript' | 'python';
export const TEST_LANGS: TestLang[] = ['typescript', 'python'];

export interface GenerateOptions {
  outDir: string; // e.g. tests/api
  deps?: DepsFile;
  version: string;
  lang?: TestLang; // default typescript
}

export interface Scenario {
  name: string; // e.g. "items/post/contract"
  kind: SuiteType | 'chain';
  status: Status;
  reason: string;
  operations: string[];
  file?: string;
}

export interface GenerateResult {
  files: string[];
  /** Generated files of earlier runs that this run no longer produces (incl. the old positive/negative layout). */
  removed: string[];
  scenarios: Scenario[];
  /** Per-operation coverage and gaps; the CLI writes it next to the report, never into the tests folder. */
  coverage: Coverage[];
}

export interface Coverage {
  operation: string;
  counts: Record<SuiteType, number>;
  positiveBlocked: string | null;
  negativeGaps: string[];
  lifecycle: string | null;
}

function jsonBodySchema(spec: LoadedSpec, op: Operation): any {
  const content = resolvePointer(spec.doc, `${operationPointer(op)}/requestBody`).node?.content ?? {};
  const key = Object.keys(content).find((k) => k.includes('json'));
  return key ? content[key].schema : undefined;
}

function planChain(spec: LoadedSpec, chain: CrudChain): { ok: true; plan: ChainPlan } | { ok: false; reason: string } {
  const unresolved = (op: Operation) => op.params.filter((p) => p.required && p.in !== 'header' && p.name !== chain.param && p.knownValue === undefined);
  for (const op of [chain.create, chain.read, chain.update, chain.delete].filter(Boolean) as Operation[]) {
    const miss = unresolved(op);
    if (miss.length) return { ok: false, reason: `${op.key} needs ${miss.map((p) => `${p.in} "${p.name}"`).join(', ')} with no value in the spec or the dependency.` };
  }
  if (!chain.delete) return { ok: false, reason: 'No delete operation is linked, so created test data could not be cleaned up. Link a delete operation or confirm that leaving data is acceptable.' };
  if (!chain.create.responses.some((r) => /^2\d\d$/.test(r.status))) return { ok: false, reason: `${chain.create.key} documents no concrete 2xx status to assert.` };

  const createSchema = jsonBodySchema(spec, chain.create);
  if (chain.create.requestBodyRequired && !createSchema) return { ok: false, reason: `${chain.create.key} requires a body but has no JSON schema.` };
  const created = createSchema ? sampleFromSchema(spec.doc, createSchema) : { ok: true as const, value: undefined, sources: [] as string[] };
  if (!created.ok) return { ok: false, reason: `Cannot build a valid create payload: ${created.reason}` };

  let updatePayload: unknown;
  let updateSources: string[] = [];
  const assumptions: string[] = [];
  if (chain.update) {
    const s = jsonBodySchema(spec, chain.update);
    const u = s ? sampleFromSchema(spec.doc, s) : undefined;
    if (u?.ok && u.value && typeof u.value === 'object' && Object.keys(u.value).length) {
      updatePayload = u.value;
      updateSources = u.sources;
      if (chain.read) assumptions.push(`after ${chain.update.operationId ?? chain.update.key}, ${chain.read.operationId ?? chain.read.key} returns the updated field values (${chain.update.method.toUpperCase()} semantics).`);
    }
  }
  return { ok: true, plan: { chain, createPayload: created.value, createSources: created.sources, updatePayload, updateSources, assumptions } };
}

const posix = (p: string) => p.replace(/\\/g, '/');

export async function generate(spec: LoadedSpec, ops: Operation[], o: GenerateOptions): Promise<GenerateResult> {
  const meta: Meta = { spec: spec.location, hash: spec.hash, version: o.version };
  const py = o.lang === 'python';
  const out = resolve(o.outDir);
  if (py) {
    // The tests folder becomes a Python package; a name that shadows a module breaks every import.
    const top = pyName(out.split(/[\\/]/).pop() ?? '');
    if (PY_RESERVED.has(top)) throw new Error(`Python tests folder "${o.outDir}" would become a package named "${top}", which shadows the "${top}" module. Choose another name, e.g. tests/api.`);
  }
  const support = join(out, '_support');
  const { refs, groups } = buildApiIndex(ops);
  const files: string[] = [];
  const removed: string[] = [];
  const scenarios: Scenario[] = [];
  const coverage: Coverage[] = [];
  const write = async (file: string, content: string) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    files.push(file);
  };

  // 1. Confirmed resource chains → payloads + data helpers.
  const { chains, candidates } = findChains(spec.doc, ops, o.deps);
  const plans: ChainPlan[] = [];
  const chainBlock = new Map<Operation, string>();
  for (const chain of chains) {
    const p = planChain(spec, chain);
    const members = [chain.create, chain.read, chain.update, chain.delete].filter(Boolean) as Operation[];
    if (p.ok) plans.push(p.plan);
    else {
      scenarios.push({ name: chain.name, kind: 'chain', status: 'BLOCKED', reason: p.reason, operations: members.map((m) => m.key) });
      for (const m of members) chainBlock.set(m, `${chain.name}: ${p.reason}`);
    }
  }
  for (const c of candidates) {
    for (const key of c.operations) {
      const op = ops.find((x) => x.key === key);
      if (op && !chainBlock.has(op)) chainBlock.set(op, c.question);
    }
  }
  const planOf = (op: Operation) => plans.find((p) => [p.chain.create, p.chain.read, p.chain.update, p.chain.delete].includes(op));
  const helperFile = (p: ChainPlan) => (py ? join(support, `${resourceModule(p)}.py`) : join(support, `${operationFolder(p.chain.create).resource}.resource.ts`));
  for (const p of plans) await write(helperFile(p), py ? renderPyResource(p, meta) : renderResourceHelpers(p, refs, meta));
  const fileNames = py ? PY_FILES : TS_FILES;
  const legacyNames = py ? ['test_positive.py', 'test_negative.py'] : ['positive.spec.ts', 'negative.spec.ts'];
  const packages = new Set<string>(); // python: every test folder is a package (__init__.py)

  // 2. Per operation: <resource>/<action>/{functional,contract,scenarios}.spec.ts, each only when it has a case.
  //    Polarity (positive/negative) is a tag inside the files, not a file of its own.
  const used = new Set<string>();
  for (const op of ops) {
    let { resource, action } = operationFolder(op);
    if (py) {
      resource = pyName(resource);
      action = pyName(action);
    }
    if (used.has(`${resource}/${action}`)) action = `${action}${py ? '_' : '-'}${(op.operationId ?? 'op').replace(/[^\w-]/g, '_')}`;
    used.add(`${resource}/${action}`);
    const dir = join(out, resource, action);
    const name = `${resource}/${action}`;
    const plan = planOf(op);
    const helpers = plan ? posix(relative(dir, helperFile(plan))).replace(/\.ts$/, '.js') : undefined;
    const safe = SAFE_METHODS.includes(op.method);
    const pathParams = op.params.filter((p) => p.in === 'path');
    const unresolvedPath = pathParams.filter((p) => p.knownValue === undefined && p.name !== plan?.chain.param);
    const unresolvedQuery = op.params.filter((p) => p.in === 'query' && p.required && p.knownValue === undefined);

    // --- positive
    let posReason: string | undefined;
    if (op.deprecated) posReason = 'Operation is deprecated.';
    else if (plan) {
      if (plan.chain.update === op && plan.updatePayload === undefined) posReason = `No example-backed payload for ${op.key}: add examples to its request schema.`;
    } else if (!safe) posReason = chainBlock.get(op) ?? `${op.key} changes data and has no confirmed precondition/cleanup (no OpenAPI links or deps file). Not generated to avoid side effects.`;
    else if (unresolvedPath.length || unresolvedQuery.length) {
      const miss = [...unresolvedPath, ...unresolvedQuery].map((p) => `${p.in} "${p.name}"`).join(', ');
      posReason = chainBlock.get(op) ?? `No value for ${miss}: add an example to the spec, or link the operation that creates it.`;
    } else if (!op.responses.some((r) => /^2\d\d$/.test(r.status))) posReason = 'No concrete 2xx response is documented.';
    else if (pathParams.some((p) => p.knownSource === 'example')) {
      // An example id ("1") is an illustration, not a record that exists on the test environment.
      const ex = pathParams.filter((p) => p.knownSource === 'example').map((p) => `"${p.name}"`).join(', ');
      posReason = chainBlock.get(op) ?? `Path ${ex} would come from a spec example, not from a real record: link the operation that creates it (OpenAPI links / --deps), or provide test data.`;
    }
    // Ending the session would log out every later test that shares the login token.
    if (!posReason && /(^|[^a-z])(log-?out|sign-?out|revoke)/i.test(`${op.path} ${op.operationId ?? ''}`)) {
      posReason = `${op.key} ends the session shared by the other tests (logout/revoke): test it with its own login, not in the generated suite.`;
    }

    // --- negative (only documented rejections)
    const rej = documentedRejections(op);
    const reachable = safe || !!plan; // never fire write requests at operations without confirmed cleanup
    const why: string[] = [];
    let bCases: ReturnType<typeof bodyCases> = [];
    let qCases: ReturnType<typeof queryCases> = [];
    let notFound: { idExpr: string; param: string } | undefined;
    let unauthorized = false;

    if (!reachable) why.push('writes without confirmed cleanup are not sent');
    else if (op.deprecated) why.push('operation is deprecated');
    else {
      if (rej.validation.length) {
        const schema = jsonBodySchema(spec, op);
        const base = plan?.chain.create === op ? plan.createPayload : plan?.chain.update === op ? plan.updatePayload : undefined;
        const bodyTarget = schema && base && typeof base === 'object' && (plan?.chain.create === op || plan?.chain.update === op);
        if (bodyTarget) bCases = bodyCases(spec.doc, schema, base as Record<string, unknown>, schema.$ref?.split('/').pop() ?? 'body');
        if (!unresolvedPath.length) qCases = queryCases(op);
        if (!bCases.length && !qCases.length) why.push(`${rej.validation.join('/')} is documented but there is no constraint the agent can break safely`);
      } else why.push('no 400/422 documented');

      const idParam = pathParams.find((p) => p.name === plan?.chain.param) ?? (pathParams.length === 1 ? pathParams[0] : undefined);
      const bodyOk = !op.requestBodyRequired || (plan?.chain.update === op && plan.updatePayload !== undefined);
      if (rej.notFound && idParam && pathParams.length === 1 && op.path.endsWith(`{${idParam.name}}`) && bodyOk) {
        notFound = { idExpr: nonexistentIdExpr(idParam.schema), param: idParam.name };
      } else if (!rej.notFound && pathParams.length) why.push('no 404 documented');

      if (op.security.length && !op.security.some((a) => a.length === 0)) {
        if (rej.unauthorized) unauthorized = true;
        else why.push('auth required but 401 not documented');
      }
    }

    // --- suites
    const input: SuiteInput = { op, refs, plan, helpers, positive: !posReason, validation: rej.validation, bodyCases: bCases, queryCases: qCases, notFound, unauthorized };
    const counts = suiteCounts(input);
    // Explicit per-operation coverage and gaps, independent of test execution status.
    coverage.push({ operation: op.key, counts, positiveBlocked: posReason ?? null, negativeGaps: why, lifecycle: plan ? plan.chain.name : null });
    const render: Record<SuiteType, (s: SuiteInput, m: Meta) => string> = py
      ? { functional: renderPyFunctional, contract: renderPyContract, scenario: renderPyScenarios }
      : { functional: renderFunctional, contract: renderContract, scenario: renderScenarios };
    const sc = scenarioCases(input);
    const role = plan ? (plan.chain.create === op ? 'create' : plan.chain.update === op ? 'update' : plan.chain.delete === op ? 'delete' : undefined) : undefined;
    for (const suite of SUITE_TYPES) {
      const label = `${name}/${suite === 'scenario' ? 'scenarios' : suite}`;
      if (counts[suite]) {
        const file = join(dir, fileNames[suite]);
        await write(file, render[suite](input, meta));
        packages.add(dir);
        scenarios.push({ name: label, kind: suite, status: 'NOT_RUN', reason: `Generated ${counts[suite]} case(s); not executed yet.`, operations: [op.key], file });
        continue;
      }
      // A suite without cases gets no file; the reason is reported instead.
      if (suite === 'scenario') {
        // Only operations with a confirmed lifecycle flow (create → read, update → read, delete → read 404) have scenarios.
        if (!role) continue;
        const r = plan!.chain.read;
        const reason = posReason ?? (!r ? 'no read operation is linked to verify the result' : role === 'delete' && !sc.deleteGone ? `${r.key} documents no 404 to verify the deletion` : 'no example-backed update payload');
        scenarios.push({ name: label, kind: suite, status: 'BLOCKED', reason: `No scenario: ${reason}`, operations: [op.key] });
        continue;
      }
      const parts = [posReason ? `success call: ${posReason}` : '', why.length ? `rejections: ${why.join('; ')}` : ''].filter(Boolean);
      scenarios.push({ name: label, kind: suite, status: 'BLOCKED', reason: `No ${suite} cases: ${parts.join(' / ') || 'nothing documented to check'}.`, operations: [op.key] });
    }

    // Generated files that this run no longer produces (old positive/negative layout, or a suite that lost its cases).
    const keep = new Set(SUITE_TYPES.filter((t) => counts[t]).map((t) => fileNames[t]));
    for (const f of [...legacyNames, ...SUITE_TYPES.map((t) => fileNames[t])]) {
      const p = join(dir, f);
      if (!keep.has(f) && (await isGenerated(p))) {
        await unlink(p);
        removed.push(p);
      }
    }
  }

  if (files.length && py) {
    // Self-contained support code: the generated suite runs without the agent installed.
    await write(join(support, 'contract.py'), await readFile(fileURLToPath(new URL('../../src/contract/contract.py', import.meta.url)), 'utf8'));
    await write(join(support, 'openapi_snapshot.json'), JSON.stringify(spec.doc, null, 2) + '\n');
    await write(join(out, 'conftest.py'), renderConftest(plans, meta));
    // Folders are packages so test_functional.py / test_contract.py / test_scenarios.py can repeat across folders.
    const inits = new Set<string>([out]);
    for (const dir of packages) for (let d = dir; d.startsWith(out) && d !== out; d = dirname(d)) inits.add(d);
    for (const d of inits) if (!existsSync(join(d, '__init__.py'))) await write(join(d, '__init__.py'), '');
  } else if (files.length) {
    // Self-contained support code: the generated suite runs without the agent installed.
    const validatorSrc = await readFile(fileURLToPath(new URL('../../src/contract/validator.ts', import.meta.url)), 'utf8');
    await write(join(support, 'contract.ts'), validatorSrc);
    await write(join(support, 'contract-assert.ts'), CONTRACT_ASSERT);
    await write(join(support, 'fixtures.ts'), await readFile(fileURLToPath(new URL('../../src/contract/fixtures.ts', import.meta.url)), 'utf8'));
    // API objects: generated bases are rewritten; the hand-written subclasses are created once and kept.
    const apiDir = join(support, 'api');
    await write(join(apiDir, 'generated', 'ApiBase.ts'), API_BASE(o.version));
    for (const g of groups) {
      await write(join(apiDir, 'generated', `${g.className}Base.ts`), renderApiBaseClass(g, refs, o.version));
      const child = join(apiDir, `${g.className}.ts`);
      if (!existsSync(child)) await write(child, renderApiChildClass(g));
    }
    await write(join(apiDir, 'generated', 'apis.ts'), renderApis(groups, o.version));
    await write(join(support, 'openapi.snapshot.ts'), `// Snapshot of ${spec.location} (hash ${spec.hash}). Regenerated with the tests.\nexport const spec: any = ${JSON.stringify(spec.doc, null, 2)};\n`);
  }
  return { files, removed, scenarios, coverage };
}

/** A file written by the generator (its first line carries the generated header), never a hand-written one. */
async function isGenerated(file: string): Promise<boolean> {
  if (!existsSync(file)) return false;
  const first = (await readFile(file, 'utf8')).split('\n', 1)[0];
  return /^(\/\/|""")\s*\S.* · \w+ cases\. Generated by api-test-agent /.test(first);
}

/** Python used for generated pytest suites: API_TESTS_PYTHON, then ./.venv, then python on PATH. */
export function findPython(): string {
  if (process.env.API_TESTS_PYTHON) return process.env.API_TESTS_PYTHON;
  const venv = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  if (existsSync(venv)) return resolve(venv);
  return process.platform === 'win32' ? 'python' : 'python3';
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');

async function runPytest(specs: Scenario[], env: { baseUrl: string }, outDir: string): Promise<void> {
  const junit = resolve(outDir, 'pytest-junit.xml');
  await mkdir(dirname(junit), { recursive: true });
  const python = findPython();
  const args = ['-m', 'pytest', ...specs.map((s) => posix(relative(process.cwd(), s.file!))), '-q', '-p', 'no:cacheprovider', `--junitxml=${junit}`];
  const output = await new Promise<string>((done) => {
    const child = spawn(python, args, { env: { ...process.env, API_BASE_URL: env.baseUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.stderr.on('data', (d) => (buf += d));
    child.on('error', (e) => done(String(e)));
    child.on('close', () => done(buf));
  });
  if (!existsSync(junit)) {
    const hint = /No module named pytest|not recognized|ENOENT/.test(output) ? ' Install: pip install pytest requests jsonschema (or set API_TESTS_PYTHON).' : '';
    for (const s of specs) Object.assign(s, { status: 'TEST_FAILURE', reason: `pytest produced no report.${hint} ${output.trim().split('\n').slice(-3).join(' ')}` });
    return;
  }
  const xml = await readFile(junit, 'utf8');
  const cases = [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map((m) => {
    const attr = (k: string) => decodeXml(new RegExp(`\\b${k}="([^"]*)"`).exec(m[1])?.[1] ?? '');
    const inner = m[2] ?? '';
    const fail = /<(failure|error)\b[^>]*message="([^"]*)"/.exec(inner);
    return { module: attr('classname'), name: attr('name'), skipped: /<skipped\b/.test(inner), failed: !!fail || /<(failure|error)\b/.test(inner), message: fail ? decodeXml(fail[2]) : '' };
  });
  for (const s of specs) {
    const parts = posix(relative(process.cwd(), s.file!)).replace(/\.py$/, '').split('/');
    const suffix = parts.slice(-3).join('.');
    const mine = cases.filter((c) => c.module.endsWith(suffix));
    if (!mine.length) {
      Object.assign(s, { status: 'TEST_FAILURE', reason: `Tests did not run (not in the pytest report). ${output.trim().split('\n').slice(-2).join(' ')}` });
      continue;
    }
    const failed = mine.filter((c) => c.failed);
    if (!failed.length) {
      Object.assign(s, { status: 'PASS', reason: `${mine.filter((c) => !c.skipped).length} test(s) executed and passed.` });
      continue;
    }
    Object.assign(s, {
      status: failed.some((c) => /CONTRACT_MISMATCH/.test(c.message)) ? 'CONTRACT_MISMATCH' : 'TEST_FAILURE',
      reason: `${failed.length}/${mine.length} failed: ` + failed.slice(0, 5).map((c) => `"${c.name}" → ${c.message.split('\n')[0]}`).join(' | '),
    });
  }
}

/** Run the generated tests once. Assertions are never modified to get a green result. */
export async function runGenerated(result: GenerateResult, env: { baseUrl: string }, outDir: string, lang: TestLang = 'typescript'): Promise<void> {
  const specs = result.scenarios.filter((s) => s.file);
  if (!specs.length) return;
  if (lang === 'python') return runPytest(specs, env, outDir);
  const jsonPath = resolve(outDir, 'playwright-results.json');
  await mkdir(dirname(jsonPath), { recursive: true });
  const cli = join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js');
  if (!existsSync(cli)) {
    for (const s of specs) s.reason = `${s.reason} Not run: @playwright/test is not installed in ${process.cwd()}.`;
    return;
  }
  const args = [cli, 'test', ...specs.map((s) => posix(relative(process.cwd(), s.file!))), '--reporter=json', '--workers=1'];
  const stdout = await new Promise<string>((done) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, API_BASE_URL: env.baseUrl, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.stderr.resume();
    child.on('close', () => done(buf));
  });
  if (!existsSync(jsonPath)) {
    for (const s of specs) Object.assign(s, { status: 'TEST_FAILURE', reason: `Playwright produced no report. ${stdout.slice(-300)}` });
    return;
  }
  const report = JSON.parse(await readFile(jsonPath, 'utf8'));
  const tests: { file: string; title: string; status: string; message: string }[] = [];
  const walk = (suite: any, file?: string) => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.[t.results.length - 1];
        tests.push({ file: posix(f ?? ''), title: spec.title, status: last?.status ?? 'unknown', message: (last?.errors ?? []).map((e: any) => e.message ?? '').join('\n') });
      }
    }
    for (const s of suite.suites ?? []) walk(s, f);
  };
  for (const s of report.suites ?? []) walk(s);

  for (const s of specs) {
    const rel = posix(relative(process.cwd(), s.file!));
    const mine = tests.filter((t) => t.file && (rel.endsWith(t.file) || t.file.endsWith(rel)));
    if (!mine.length) {
      Object.assign(s, { status: 'TEST_FAILURE', reason: 'Tests did not run (not found in the Playwright report).' });
      continue;
    }
    const failed = mine.filter((t) => t.status !== 'passed' && t.status !== 'skipped');
    if (!failed.length) {
      Object.assign(s, { status: 'PASS', reason: `${mine.length} test(s) executed and passed.` });
      continue;
    }
    const clean = (m: string) => m.replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim())?.replace(/^Error:\s*/, '') ?? '';
    const mismatch = failed.some((t) => /CONTRACT_MISMATCH/.test(t.message));
    Object.assign(s, {
      status: mismatch ? 'CONTRACT_MISMATCH' : 'TEST_FAILURE',
      reason: `${failed.length}/${mine.length} failed: ` + failed.slice(0, 5).map((t) => `"${t.title}" → ${clean(t.message)}`).join(' | '),
    });
  }
}

const SEVERITY: Status[] = ['CONTRACT_MISMATCH', 'TEST_FAILURE', 'PASS', 'NOT_RUN', 'BLOCKED'];

/** One functional finding per operation: the most important status across its suite files. */
export function scenarioFindings(result: GenerateResult): Finding[] {
  const byOp = new Map<string, Scenario[]>();
  for (const s of result.scenarios) for (const op of s.operations) byOp.set(op, [...(byOp.get(op) ?? []), s]);
  return [...byOp.entries()].map(([operation, list]) => {
    const top = [...list].sort((a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status))[0];
    return { operation, source: 'generate', status: top.status, reason: list.map((s) => `${s.name}: ${s.status} - ${s.reason}`).join(' / ') };
  });
}
