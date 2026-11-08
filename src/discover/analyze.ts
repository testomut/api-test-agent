import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Operation } from '../types.js';
import type { OpenApiDoc } from '../spec/loader.js';
import { findChains } from '../generate/graph.js';
import { documentedRejections } from '../generate/negative.js';
import { operationFolder } from '../generate/templates.js';
import { scanProject, type FoundFile } from './scan.js';
import { PlaywrightAnalyzer, type FileIssue, type TestCase } from './playwright-tests.js';
import { loadPostman, type PostmanCollection } from './postman.js';

export type EdgeSource = 'openapi-links' | 'existing-tests' | 'postman' | 'candidate';

export interface DependencyEdge {
  from: string; // operation key "POST /orders"
  to: string;
  source: EdgeSource;
  variable?: string;
  cleanup?: boolean;
  evidence: string[];
}

export interface CoverageRow {
  operation: string;
  inSpec: boolean;
  positiveTests: string[];
  negativeTests: string[];
  usedAsPrecondition: number;
  postman: string[];
  generatedPositive: boolean;
  generatedNegative: boolean;
  negativePossible: boolean;
}

export interface Proposal {
  kind: 'move-test' | 'convert-postman' | 'generate';
  from?: string;
  to: string;
  detail: string;
}

export interface Analysis {
  inventory: FoundFile[];
  apiTestsOutsideDir: string[];
  tests: TestCase[];
  testIssues: FileIssue[];
  postman: PostmanCollection[];
  postmanErrors: string[];
  postmanIssues: string[];
  edges: DependencyEdge[];
  coverage: CoverageRow[];
  notInSpec: string[];
  proposals: Proposal[];
}

/** Map a concrete call path onto a spec operation (path templates match any value in {param} segments). */
export function matchOperation(method: string, path: string, ops: Operation[]): string {
  const segs = path.split('/').filter(Boolean);
  const candidates = ops.filter((o) => o.method.toUpperCase() === method);
  for (let skip = 0; skip <= Math.min(3, segs.length); skip++) {
    const s = segs.slice(skip);
    const hit = candidates.find((o) => {
      const t = o.path.split('/').filter(Boolean);
      return t.length === s.length && t.every((seg, i) => seg.startsWith('{') || seg === s[i] || /^\{.*\}$/.test(s[i]) && seg.startsWith('{'));
    });
    if (hit) return hit.key;
  }
  return `${method} /${segs.map((x) => (/^\{.*\}$/.test(x) ? '{id}' : x)).join('/')}`;
}

const posix = (p: string) => p.replace(/\\/g, '/');

export async function analyzeProject(o: {
  root: string;
  testsDir: string;
  doc?: OpenApiDoc;
  ops: Operation[];
  postmanRef?: string;
  postmanApiKey?: string;
}): Promise<Analysis> {
  const { root, ops } = o;
  const testsDir = posix(o.testsDir).replace(/\/$/, '');
  const scan = await scanProject(root);
  const apiFiles = scan.tests.filter((t) => t.kind === 'playwright-api');

  // --- Playwright tests
  const analyzer = new PlaywrightAnalyzer();
  const sources = new Map<string, string>();
  for (const f of [...scan.supportFiles, ...apiFiles.map((t) => t.path)]) sources.set(f, await readFile(join(root, f), 'utf8'));
  for (let pass = 0; pass < 2; pass++) for (const [f, src] of sources) analyzer.indexHelpers(f, src); // 2 passes: helpers calling helpers
  const tests: TestCase[] = [];
  const testIssues: FileIssue[] = [];
  const edges: DependencyEdge[] = [];
  const addEdge = (e: DependencyEdge) => {
    if (e.from === e.to) return;
    const same = edges.find((x) => x.from === e.from && x.to === e.to && x.source === e.source);
    if (same) same.evidence = [...new Set([...same.evidence, ...e.evidence])];
    else edges.push(e);
  };
  for (const f of apiFiles) {
    const r = analyzer.analyzeTestFile(f.path, sources.get(f.path)!);
    tests.push(...r.tests);
    testIssues.push(...r.issues);
    for (const e of r.edges) {
      addEdge({
        from: matchOperation(e.from.method, e.from.path, ops),
        to: matchOperation(e.to.method, e.to.path, ops),
        source: 'existing-tests',
        variable: e.variable,
        cleanup: e.to.cleanup,
        evidence: [`${f.path}:${e.to.line}`],
      });
    }
  }

  // --- Postman: configured collection + collections found in the repository
  const postman: PostmanCollection[] = [];
  const postmanErrors: string[] = [];
  const refs = new Set<string>(scan.tests.filter((t) => t.kind === 'postman-collection').map((t) => t.path));
  if (o.postmanRef) refs.add(o.postmanRef);
  for (const ref of refs) {
    try {
      postman.push(await loadPostman(ref, root, o.postmanApiKey));
    } catch (e: any) {
      postmanErrors.push(String(e?.message ?? e));
    }
  }
  const postmanIssues: string[] = [];
  for (const c of postman) {
    for (const e of c.edges) {
      addEdge({
        from: matchOperation(e.from.method, e.from.path, ops),
        to: matchOperation(e.to.method, e.to.path, ops),
        source: 'postman',
        variable: e.variable,
        evidence: [`${c.name}: "${e.from.name}" → "${e.to.name}"`],
      });
      if (e.outOfOrder) postmanIssues.push(`${c.name}: "${e.to.name}" uses {{${e.variable}}} set by a LATER request ("${e.from.name}"): runs only with stale data.`);
    }
    for (const r of c.requests) {
      if (!r.tests) postmanIssues.push(`${c.name}: "${r.name}" has no pm.test assertions.`);
      if (r.hardcodedAuth) postmanIssues.push(`${c.name}: "${r.name}" has a hard-coded Authorization header: use {{token}}.`);
    }
  }

  // --- OpenAPI links + candidates
  if (o.doc) {
    const { chains, candidates } = findChains(o.doc, ops);
    for (const c of chains) {
      for (const t of [c.read, c.update, c.delete]) if (t) addEdge({ from: c.create.key, to: t.key, source: 'openapi-links', variable: c.param, evidence: [c.source] });
    }
    for (const c of candidates) {
      const [from, ...tos] = c.operations;
      for (const to of tos) if (!edges.some((e) => e.from === from && e.to === to)) addEdge({ from, to, source: 'candidate', evidence: [c.question] });
    }
  }

  // --- Coverage map
  const keys = new Set<string>(ops.map((op) => op.key));
  const covered = (k: string) => {
    if (!keys.has(k)) keys.add(k);
    return k;
  };
  const rows = new Map<string, CoverageRow>();
  const row = (k: string): CoverageRow => {
    covered(k);
    if (!rows.has(k)) {
      const op = ops.find((x) => x.key === k);
      const rej = op ? documentedRejections(op) : undefined;
      const folder = op ? operationFolder(op) : undefined;
      const dir = folder ? join(root, testsDir, folder.resource, folder.action) : undefined;
      rows.set(k, {
        operation: k,
        inSpec: !!op,
        positiveTests: [],
        negativeTests: [],
        usedAsPrecondition: 0,
        postman: [],
        generatedPositive: !!dir && existsSync(join(dir, 'positive.spec.ts')),
        generatedNegative: !!dir && existsSync(join(dir, 'negative.spec.ts')),
        negativePossible: !!rej && (rej.validation.length > 0 || rej.notFound || rej.unauthorized),
      });
    }
    return rows.get(k)!;
  };
  for (const op of ops) row(op.key);
  for (const t of tests) {
    const ref = `${t.file}:${t.line}`;
    for (const a of t.asserted) {
      const k = matchOperation(a.call.method, a.call.path, ops);
      const neg = a.statuses.some((s) => s >= 400);
      const list = neg ? row(k).negativeTests : row(k).positiveTests;
      if (!list.includes(ref)) list.push(ref);
    }
    for (const c of [...t.preconditions, ...t.calls.filter((c) => !t.asserted.some((a) => a.call === c))]) {
      if (!c.cleanup) row(matchOperation(c.method, c.path, ops)).usedAsPrecondition++;
    }
  }
  for (const c of postman) for (const r of c.requests) row(matchOperation(r.method, r.path, ops)).postman.push(`${c.name}: ${r.name}`);
  const coverage = [...rows.values()];
  const notInSpec = ops.length ? coverage.filter((r) => !r.inSpec).map((r) => r.operation) : [];

  // --- Proposals
  const proposals: Proposal[] = [];
  const layout = new RegExp(`^${testsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+/[^/]+/(positive|negative)(\\.[\\w-]+)?\\.spec\\.[cm]?[jt]s$`);
  for (const f of apiFiles) {
    if (layout.test(f.path)) continue;
    for (const t of tests.filter((x) => x.file === f.path)) {
      const main = t.asserted[0]?.call ?? t.calls.filter((c) => !c.cleanup).pop();
      if (!main) continue;
      const key = matchOperation(main.method, main.path, ops);
      const op = ops.find((x) => x.key === key) ?? ({ method: main.method.toLowerCase(), path: key.split(' ')[1] } as Operation);
      const { resource, action } = operationFolder(op);
      const kind = t.polarity === 'negative' ? 'negative' : 'positive';
      proposals.push({ kind: 'move-test', from: `${t.file}:${t.line}`, to: `${testsDir}/${resource}/${action}/${kind}.manual.spec.ts`, detail: `"${t.title}"` });
    }
  }
  const testedKeys = new Set(coverage.filter((r) => r.positiveTests.length || r.negativeTests.length).map((r) => r.operation));
  for (const c of postman) {
    for (const r of c.requests) {
      const key = matchOperation(r.method, r.path, ops);
      if (testedKeys.has(key)) continue;
      const op = ops.find((x) => x.key === key) ?? ({ method: r.method.toLowerCase(), path: key.split(' ')[1] } as Operation);
      const { resource, action } = operationFolder(op);
      const kind = r.statuses.some((s) => s >= 400) ? 'negative' : 'positive';
      proposals.push({ kind: 'convert-postman', from: `${c.name}: ${r.name}`, to: `${testsDir}/${resource}/${action}/${kind}.postman.spec.ts`, detail: `${r.tests} pm.test assertion(s)${r.statuses.length ? `, statuses ${r.statuses.join('/')}` : ''}` });
    }
  }
  // Generation proposals, with the same safety rules `generate` applies, so the list is honest.
  const fromPostman = new Set(proposals.filter((p) => p.kind === 'convert-postman').map((p) => p.to.replace(/\/(positive|negative)\.postman\.spec\.ts$/, '')));
  const linked = new Set(edges.filter((e) => e.source === 'openapi-links').flatMap((e) => [e.from, e.to]));
  for (const r of coverage.filter((x) => x.inSpec)) {
    const op = ops.find((x) => x.key === r.operation)!;
    const { resource, action } = operationFolder(op);
    const unsafe = !['get', 'head', 'options'].includes(op.method);
    const missingParam = op.params.find((p) => p.required && p.in !== 'header' && p.knownValue === undefined);
    const blocked = unsafe && !linked.has(op.key)
      ? 'changes data and the spec confirms no precondition/cleanup (add OpenAPI links or a deps file)'
      : missingParam && !linked.has(op.key)
        ? `no value for ${missingParam.in} "${missingParam.name}" (add an example or link the operation that creates it)`
        : undefined;
    if (!r.positiveTests.length && !r.generatedPositive && !fromPostman.has(`${testsDir}/${resource}/${action}`)) {
      proposals.push({ kind: 'generate', to: r.operation, detail: blocked ? `positive cases: BLOCKED, ${blocked}` : 'positive cases (no existing test asserts this operation)' });
    }
    if (r.negativePossible && !r.negativeTests.length && !r.generatedNegative) {
      proposals.push({ kind: 'generate', to: r.operation, detail: blocked && unsafe ? `negative cases: BLOCKED, ${blocked}` : 'negative cases (rejections documented, none tested)' });
    }
  }

  const apiTestsOutsideDir = apiFiles.map((f) => f.path).filter((p) => !p.startsWith(testsDir + '/'));
  return { inventory: scan.tests, apiTestsOutsideDir, tests, testIssues, postman, postmanErrors, postmanIssues, edges, coverage, notInSpec, proposals };
}
