import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAFE_METHODS, type Finding, type Operation, type Status } from '../types.js';
import { resolvePointer, type LoadedSpec } from '../spec/loader.js';
import { operationPointer } from '../spec/catalog.js';
import { findChains, type CrudChain, type DepsFile } from './graph.js';
import { sampleFromSchema } from './sample.js';
import { assignCaseIds, type CaseRecord, type ScenarioDefinition } from '../cases/assign.js';
import { buildRegistry, canonicalJson, fileHash, readRegistry, resolveOperationUids } from '../cases/registry.js';
import { headRevision } from '../change/baseline.js';
import { isUrl } from '../change/network.js';
import { bodyCasesDetailed, compositionGaps, type CoverageGap } from './body-cases.js';
import { paramCasesDetailed, sendable } from './param-cases.js';
import { errorPlan } from './error-cases.js';
import { collectionGaps, resolveCollection } from './collection.js';
import { collectionStrategy, planCollectionTests } from './collection-tests.js';
import { tsFixtureModule, fixtureModule, type CollectionInput } from './collection-render.js';
import type { LoadedFixture } from '../fixtures/fixtures.js';
import { positiveCode, uncheckedRequest, uncheckedStatuses } from './coverage.js';
import type { ResolvedScenario } from '../scenarios/dsl.js';
import { bodyCases, documentedRejections, nonexistentIdExpr, type NegCase } from './negative.js';
import { CONTRACT_ASSERT, SUITE_TYPES, TS_FILES, operationFolder, queryVariants, renderContract, renderFunctional, renderResourceHelpers, renderScenarios, scenarioCases, suiteCounts, type ChainPlan, type Meta, type SuiteInput, type SuiteType } from './templates.js';
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
  /** Body negative cases per operation (default 60); the rest is reported as CASE_LIMIT_REACHED. */
  maxCases?: number;
  /** Reviewed business scenarios (validated with validateScenarios against the same operations). */
  scenarios?: ResolvedScenario[];
  /** Approved fixtures (strategy B), already validated against the spec; invalid ones arrive as fixtureErrors. */
  fixtures?: LoadedFixture[];
  fixtureErrors?: { file: string; operationId?: string; errors: string[] }[];
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
  /** Test data the generated cleanup could not remove during --run (it stays on the target). */
  cleanupFailures: CleanupFailure[];
  /** After --run: every physical test has its own registered case ID. */
  caseIdCheck?: CaseIdCheck;
}

export interface CleanupFailure {
  operation: string;
  id: string;
  status: number | string;
}

export interface Coverage {
  operation: string;
  counts: Record<SuiteType, number>;
  positiveBlocked: string | null;
  negativeGaps: string[];
  lifecycle: string | null;
  /** Checks that could not be generated, each with a machine code and its exact location. */
  gaps: CoverageGap[];
  /** Body negative cases found / generated / dropped by the limit. */
  bodyCases?: { potential: number; generated: number; dropped: number };
  /** Machine code of positiveBlocked. */
  positiveBlockedCode: string | null;
  /** Per suite: generated tests, and the code when the suite is empty. */
  suites: Record<SuiteType, { generated: number; missingCode: string | null }>;
  /** Documented statuses no generated test exercises. */
  uncheckedStatuses: { status: string; code: string }[];
  /** Request media types never sent (the suite sends JSON). */
  uncheckedRequestContentTypes: string[];
  /** Security alternatives beyond the one the suite uses. */
  uncheckedSecurityAlternatives: string[][];
  /** List operations: how the collection is tested (create-verify / read-only / contract-only) and why. */
  collection?: { strategy: string; reasons: string[]; tests: { kind: string; mode: string }[] };
}

function jsonBodySchema(spec: LoadedSpec, op: Operation): any {
  const content = resolvePointer(spec.doc, `${operationPointer(op)}/requestBody`).node?.content ?? {};
  const key = Object.keys(content).find((k) => k.includes('json'));
  return key ? content[key].schema : undefined;
}

/** Top-level properties of an object schema ($ref and allOf resolved). */
function topProperties(spec: LoadedSpec, schema: any, depth = 0): Record<string, any> {
  if (!schema || typeof schema !== 'object' || depth > 8) return {};
  if (schema.$ref) return topProperties(spec, resolvePointer(spec.doc, schema.$ref.slice(1)).node, depth + 1);
  const own = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]: [string, any]) => [k, v?.$ref ? resolvePointer(spec.doc, v.$ref.slice(1)).node : v]));
  return Object.assign({}, ...(schema.allOf ?? []).map((p: any) => topProperties(spec, p, depth + 1)), own);
}

/** Sample suffix used to check that a suffixed value still satisfies the property's pattern. */
const UNIQUE_PROBE = '-a1b2c3';

/**
 * String fields of the example payload that must differ on every call: the operation documents 409 (conflict),
 * so a fixed example value collides with data left by an earlier run or another user of a shared environment.
 * Fields with enum / const / format are never touched; a pattern must still match with the suffix.
 * Value: maxLength of the field (the example is shortened to fit), or null.
 */
export function uniqueFields(spec: LoadedSpec, op: Operation, schema: unknown, payload: unknown): Record<string, number | null> {
  if (!op.responses.some((r) => r.status === '409') || !payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const props = topProperties(spec, schema);
  const out: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(payload)) {
    const p = props[key];
    if (typeof value !== 'string' || !p || p.enum || p.const !== undefined || p.format) continue;
    if (typeof p.pattern === 'string') {
      try {
        if (!new RegExp(p.pattern, 'u').test(value + UNIQUE_PROBE)) continue;
      } catch {
        continue;
      }
    }
    out[key] = typeof p.maxLength === 'number' ? p.maxLength : null;
  }
  return out;
}

function planChain(spec: LoadedSpec, chain: CrudChain): { ok: true; plan: ChainPlan } | { ok: false; reason: string } {
  const unresolved = (op: Operation) => op.params.filter((p) => p.required && p.in !== 'header' && p.name !== chain.param && p.knownValue === undefined);
  for (const op of [chain.create, chain.read, chain.update, chain.delete].filter(Boolean) as Operation[]) {
    const miss = unresolved(op);
    if (miss.length) return { ok: false, reason: `${op.key} needs ${miss.map((p) => `${p.in} "${p.name}"`).join(', ')} with no value in the spec or the dependency.` };
  }
  if (!chain.delete) return { ok: false, reason: 'No delete operation is linked, so created test data could not be cleaned up. Link a delete operation or confirm that leaving data is acceptable.' };
  if (!chain.create.responses.some((r) => /^2\d\d$/.test(r.status))) return { ok: false, reason: `${chain.create.key} documents no concrete 2xx status to assert.` };
  // "fill" reads existing data, so its source must be a safe call the test can make as is.
  for (const f of chain.fill ?? []) {
    const where = `fill "${f.field}"`;
    if (!f.from) return { ok: false, reason: `${where}: operation "${f.fromId}" is not in the spec.` };
    if (f.from.method !== 'get') return { ok: false, reason: `${where}: ${f.from.key} is not a GET; values are only read from existing data, never created.` };
    const miss = f.from.params.filter((p) => p.required && p.in !== 'header' && p.knownValue === undefined);
    if (miss.length) return { ok: false, reason: `${where}: ${f.from.key} needs ${miss.map((p) => `${p.in} "${p.name}"`).join(', ')} with no value in the spec.` };
    if (typeof f.pointer !== 'string' || !f.pointer.startsWith('/')) return { ok: false, reason: `${where}: pointer must be a JSON pointer such as "/data/0/id".` };
  }

  const createSchema = jsonBodySchema(spec, chain.create);
  if (chain.create.requestBodyRequired && !createSchema) return { ok: false, reason: `${chain.create.key} requires a body but has no JSON schema.` };
  const created = createSchema ? sampleFromSchema(spec.doc, createSchema) : { ok: true as const, value: undefined, sources: [] as string[] };
  if (!created.ok) return { ok: false, reason: `Cannot build a valid create payload: ${created.reason}` };

  let updatePayload: unknown;
  let updateSources: string[] = [];
  let uniqueUpdate: Record<string, number | null> = {};
  const assumptions: string[] = [];
  if (chain.update) {
    const s = jsonBodySchema(spec, chain.update);
    const u = s ? sampleFromSchema(spec.doc, s) : undefined;
    if (u?.ok && u.value && typeof u.value === 'object' && Object.keys(u.value).length) {
      updatePayload = u.value;
      updateSources = u.sources;
      uniqueUpdate = uniqueFields(spec, chain.update, s, u.value);
      if (chain.read) assumptions.push(`after ${chain.update.operationId ?? chain.update.key}, ${chain.read.operationId ?? chain.read.key} returns the updated field values (${chain.update.method.toUpperCase()} semantics).`);
    }
  }
  // A filled value is real data from the API: never suffixed.
  const uniqueCreate = uniqueFields(spec, chain.create, createSchema, created.value);
  for (const f of chain.fill ?? []) delete uniqueCreate[f.field];
  const createSources = [...created.sources, ...(chain.fill ?? []).map((f) => `$.${f.field}: filled at run time from ${f.from!.key} #${f.pointer}`)];
  return { ok: true, plan: { chain, createPayload: created.value, createSources, updatePayload, updateSources, uniqueCreate, uniqueUpdate, assumptions } };
}

const posix = (p: string) => p.replace(/\\/g, '/');

/** Playwright globalSetup of a generated suite: the run's test account (API_TEST_ACCOUNT=auto) decided once. */
const GLOBAL_SETUP = `// Generated by api-test-agent. Playwright globalSetup: settles the run's test account once (API_TEST_ACCOUNT=auto).
// Use it in playwright.config.ts: globalSetup: './<tests dir>/_support/global-setup.ts'
import { request, type FullConfig } from '@playwright/test';
import { prepareRunAccount } from './fixtures.js';

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = (config.projects[0]?.use as { baseURL?: string } | undefined)?.baseURL ?? process.env.API_BASE_URL;
  await prepareRunAccount({ request } as Parameters<typeof prepareRunAccount>[0], baseURL);
}
`;

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
  const hashes = new Map<string, string>(); // canonical hash of every file this run wrote (for the manifest)
  const write = async (file: string, content: string) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    files.push(file);
    hashes.set(file, fileHash(content));
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
  // Reviewed collection mappings (deps "collection"): checked strictly against the spec; errors become gaps.
  const collectionOf = new Map<Operation, { plan: ChainPlan; c: NonNullable<ReturnType<typeof resolveCollection>['collection']> }>();
  const collectionErrors = new Map<string, CoverageGap[]>();
  for (const chain of chains) {
    if (!chain.collection) continue;
    const r = resolveCollection(spec.doc, ops, chain.collection);
    const key = ops.find((x) => x.operationId === chain.collection!.operationId)?.key ?? '';
    const p = plans.find((x) => x.chain === chain);
    if (r.collection && p) collectionOf.set(r.collection.op, { plan: p, c: r.collection });
    else {
      const gaps: CoverageGap[] = r.errors.map((reason) => ({ code: 'INVALID_REVIEWED_CONFIG', location: 'operation', reason }));
      if (r.collection && !p) gaps.push({ code: 'MISSING_CLEANUP', location: 'operation', reason: `collection of ${chain.name}: the chain is blocked, so no collection tests are generated` });
      collectionErrors.set(key, [...(collectionErrors.get(key) ?? []), ...gaps]);
    }
  }
  const planOf = (op: Operation) => plans.find((p) => [p.chain.create, p.chain.read, p.chain.update, p.chain.delete].includes(op));
  const helperFile = (p: ChainPlan) => (py ? join(support, `${resourceModule(p)}.py`) : join(support, `${operationFolder(p.chain.create).resource}.resource.ts`));
  for (const p of plans) await write(helperFile(p), py ? renderPyResource(p, meta) : renderResourceHelpers(p, refs, meta));
  // Stable IDs: the registry keeps operationUids across generations; new operations get the deterministic hash.
  const registryFile = join(support, 'cases.json');
  const previousRegistry = await readRegistry(registryFile);
  const specOps = ops.map((op) => ({ key: op.key, method: op.method, path: op.path, operationId: op.operationId, externalId: externalIdOf(spec, op) }));
  const uids = resolveOperationUids(specOps, previousRegistry);
  const uidOf = (op: Operation) => uids.get(op.key)!;
  const allCases: CaseRecord[] = [];
  const scenarioDefs: Record<string, ScenarioDefinition> = {};
  const fileInfo = new Map<string, { suiteType: SuiteType; caseIds: string[]; operationUids: string[] }>();

  const fileNames = py ? PY_FILES : TS_FILES;
  const legacyNames = py ? ['test_positive.py', 'test_negative.py'] : ['positive.spec.ts', 'negative.spec.ts'];
  const packages = new Set<string>(); // python: every test folder is a package (__init__.py)

  // 2. Per operation: <resource>/<action>/{functional,contract,scenarios}.spec.ts, each only when it has a case.
  //    Polarity (positive/negative) is a tag inside the files, not a file of its own.
  const used = new Set<string>();
  const paths405 = new Set<string>(); // one 405 case per path
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
    const coll = collectionOf.get(op);
    const helperPlan = plan ?? coll?.plan;
    const helpers = helperPlan ? posix(relative(dir, helperFile(helperPlan))).replace(/\.ts$/, '.js') : undefined;
    const safe = SAFE_METHODS.includes(op.method);
    const pathParams = op.params.filter((p) => p.in === 'path');
    const unresolvedPath = pathParams.filter((p) => p.knownValue === undefined && p.name !== plan?.chain.param);
    // Required query / header / cookie parameters need a documented value, or no valid request exists.
    const unresolvedQuery = op.params.filter((p) => p.in !== 'path' && p.required && p.knownValue === undefined && sendable(p));

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
    let bodyGaps: CoverageGap[] = [];
    let bodyStats: Coverage['bodyCases'];
    let qCases: NegCase[] = [];
    let notFound: { idExpr: string; param: string } | undefined;
    let unauthorized = false;

    if (!reachable) why.push('writes without confirmed cleanup are not sent');
    else if (op.deprecated) why.push('operation is deprecated');
    else {
      if (rej.validation.length) {
        const schema = jsonBodySchema(spec, op);
        const base = plan?.chain.create === op ? plan.createPayload : plan?.chain.update === op ? plan.updatePayload : undefined;
        const bodyTarget = schema && base && typeof base === 'object' && (plan?.chain.create === op || plan?.chain.update === op);
        if (bodyTarget) {
          const detailed = bodyCasesDetailed(spec.doc, schema, base, schema.$ref?.split('/').pop() ?? 'body', o.maxCases);
          bCases = detailed.cases;
          bodyGaps = detailed.gaps;
          bodyStats = { potential: detailed.potential, generated: detailed.cases.length, dropped: detailed.dropped.length };
        }
        // Path parameters: only where an invalid value cannot reach a request body we cannot build.
        const allowPath = !op.requestBodyRequired;
        const pc = paramCasesDetailed(spec.doc, op, { allowPath, allowOthers: !unresolvedPath.length });
        qCases = pc.cases;
        bodyGaps = [...bodyGaps, ...pc.gaps];
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
    // Documented error responses with a safe trigger; the rest are gaps (stage 6).
    const errRole = !plan ? undefined : plan.chain.create === op ? 'create' : plan.chain.read === op ? 'read' : plan.chain.update === op ? 'update' : plan.chain.delete === op ? 'delete' : undefined;
    const firstWith405 = op.responses.some((r) => r.status === '405') && !paths405.has(op.path);
    if (firstWith405) paths405.add(op.path);
    const errors = op.deprecated ? { gaps: [] } : errorPlan({ doc: spec.doc, op, ops, chain: plan?.chain, role: errRole, hasUpdatePayload: plan?.updatePayload !== undefined, reachable, firstWith405 });
    const input: SuiteInput = { op, refs, plan, helpers, positive: !posReason, validation: rej.validation, bodyCases: bCases, paramCases: qCases, notFound, unauthorized, errors, business: (o.scenarios ?? []).filter((b) => b.primaryOp === op) };
    let collPlan: ReturnType<typeof planCollectionTests> | undefined;
    if (coll && input.positive && !op.deprecated) {
      const ch = coll.plan.chain;
      collPlan = planCollectionTests(spec.doc, coll.c, { canCreate: !!ch.delete, createSchema: jsonBodySchema(spec, ch.create), canUpdate: !!ch.update && coll.plan.updatePayload !== undefined, updatePayload: coll.plan.updatePayload, canDelete: !!ch.delete });
      input.collection = { plan: collPlan, chain: coll.plan } satisfies CollectionInput;
    }
    const fixture = input.positive && !op.deprecated ? o.fixtures?.find((f) => f.op === op) : undefined;
    if (fixture) input.fixture = fixture;
    const fixtureGaps: CoverageGap[] = (o.fixtureErrors ?? []).filter((e) => e.operationId && e.operationId === op.operationId).flatMap((e) => e.errors.map((reason) => ({ code: 'INVALID_REVIEWED_CONFIG', location: 'operation', reason: `${e.file}: ${reason}` })));
    const collGaps: CoverageGap[] = [...fixtureGaps, ...(collectionErrors.get(op.key) ?? []), ...(collPlan?.gaps ?? []), ...(coll ? [] : collectionGaps(spec.doc, op, false))];
    const counts = suiteCounts(input);
    const variants = input.positive && !plan && op.method === 'get' ? queryVariants(op) : [];
    const ids = assignCaseIds({ op, chain: plan?.chain, positive: input.positive, bodyCases: bCases, paramCases: qCases, notFound, unauthorized, scenarios: scenarioCases(input), queryVariants: variants, errors, business: input.business, collection: collPlan, collectionChain: coll?.plan.chain, fixture: !!fixture }, uidOf);
    input.ids = ids;
    // Explicit per-operation coverage and gaps, independent of test execution status.
    // oneOf / anyOf in a payload that is sent: the other branches are reported (never dropped silently).
    const payloadSchema = plan && (plan.chain.create === op || plan.chain.update === op) ? jsonBodySchema(spec, op) : undefined;
    const payloadValue = plan?.chain.create === op ? plan.createPayload : plan?.chain.update === op ? plan.updatePayload : undefined;
    const variantGaps: CoverageGap[] = payloadSchema && payloadValue !== undefined ? compositionGaps(spec.doc, payloadSchema, payloadValue) : [];
    // Response bodies the validator cannot check: said explicitly, never passed silently.
    const responseGaps: CoverageGap[] = op.responses.flatMap((resp) =>
      resp.contentTypes.flatMap((ct): CoverageGap[] => {
        const media = ct.split(';')[0].trim().toLowerCase();
        const loc = `response.content-type#/${media.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        if (!resp.hasSchema) return [{ code: 'MISSING_RESPONSE_SCHEMA', location: loc, reason: `${resp.status} ${media}: no schema documented, the body is not checked` }];
        if (!media.includes('json') && !media.startsWith('text/')) return [{ code: 'UNSUPPORTED_MEDIA_TYPE', location: loc, reason: `${resp.status} ${media}: the validator checks JSON and text bodies only` }];
        return [];
      }),
    );
    const pCode = positiveCode(posReason);
    const req = uncheckedRequest(op);
    const scn = scenarioCases(input);
    coverage.push({
      operation: op.key,
      counts,
      positiveBlocked: posReason ?? null,
      positiveBlockedCode: pCode,
      negativeGaps: why,
      lifecycle: plan ? plan.chain.name : null,
      gaps: [...bodyGaps, ...errors.gaps, ...variantGaps, ...responseGaps, ...collGaps],
      ...(coll || fixture || collGaps.length ? { collection: { ...collectionStrategy(collPlan, collGaps.map((g) => g.reason), !!fixture), tests: [...(collPlan?.tests ?? []).map((t) => ({ kind: t.kind, mode: t.mode })), ...(fixture ? [{ kind: 'fixture', mode: 'approved' }] : [])] } } : {}),
      ...(bodyStats ? { bodyCases: bodyStats } : {}),
      suites: {
        functional: { generated: counts.functional, missingCode: counts.functional ? null : pCode ?? 'NO_DOCUMENTED_REJECTION' },
        contract: { generated: counts.contract, missingCode: counts.contract ? null : pCode ?? 'NO_DOCUMENTED_REJECTION' },
        scenario: { generated: counts.scenario, missingCode: counts.scenario ? null : plan ? pCode ?? 'UNCONFIRMED_BUSINESS_RULE' : 'UNCONFIRMED_BUSINESS_RULE' },
      },
      uncheckedStatuses: uncheckedStatuses(op, { positive: input.positive, notFound: !!notFound, unauthorized, validation: rej.validation, invalidInput: bCases.length + qCases.length > 0, errors, deleteTwice: scn.deleteTwice }),
      uncheckedRequestContentTypes: req.contentTypes,
      uncheckedSecurityAlternatives: req.securityAlternatives,
    });
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
        const recs = ids.records[suite];
        allCases.push(...recs);
        for (const r of recs) if (ids.scenarios[r.subjectUid]) scenarioDefs[r.subjectUid] = ids.scenarios[r.subjectUid];
        fileInfo.set(file, { suiteType: suite, caseIds: recs.map((r) => r.caseId), operationUids: [...new Set([uidOf(op), ...recs.flatMap((r) => r.relatedOperationUids ?? [])])] });
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

  // Approved fixtures used by this run, copied next to the suite (the suite runs without the agent).
  for (const f of o.fixtures ?? []) {
    if (!coverage.some((c) => c.operation === f.op.key && c.collection?.tests.some((t) => t.kind === 'fixture'))) continue;
    await write(join(support, 'approved', py ? `${fixtureModule(f)}.json` : `${fixtureModule(f)}.fixture.ts`), py ? JSON.stringify(f.fixture, null, 2) + '\n' : tsFixtureModule(f, o.version));
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
    await write(join(support, 'global-setup.ts'), GLOBAL_SETUP);
    // API objects: generated bases are rewritten; the hand-written subclasses are created once and kept.
    const apiDir = join(support, 'api');
    await write(join(apiDir, 'generated', 'ApiBase.ts'), API_BASE(o.version));
    for (const g of groups) {
      await write(join(apiDir, 'generated', `${g.className}Base.ts`), renderApiBaseClass(g, refs, o.version));
      const child = join(apiDir, `${g.className}.ts`);
      if (!existsSync(child)) await write(child, renderApiChildClass(g));
      else hashes.set(child, fileHash(await readFile(child, 'utf8'))); // kept in the manifest as hand-written, never rewritten
    }
    await write(join(apiDir, 'generated', 'apis.ts'), renderApis(groups, o.version));
    await write(join(support, 'openapi.snapshot.ts'), `// Snapshot of ${spec.location} (hash ${spec.hash}). Regenerated with the tests.\nexport const spec: any = ${JSON.stringify(spec.doc, null, 2)};\n`);
  }
  // Resource helpers of chains this run no longer plans (e.g. a delete was unlinked): generated ones only.
  const helpers = new Set(plans.map((p) => resolve(helperFile(p))));
  const helperPattern = py ? /_resource\.py$/ : /\.resource\.ts$/;
  for (const name of existsSync(support) ? await readdir(support) : []) {
    const p = join(support, name);
    if (helperPattern.test(name) && !helpers.has(resolve(p)) && (await isGeneratedHelper(p))) {
      await unlink(p);
      removed.push(p);
    }
  }
  if (files.length) {
    // Registry, snapshot metadata and, last of all, the generation manifest.
    const revision = isUrl(spec.location) || !existsSync(spec.location) ? `sha256:${spec.hash}` : await headRevision(spec.location);
    const registry = buildRegistry({ previous: previousRegistry, ops: specOps, uids, cases: allCases, scenarios: scenarioDefs, spec: { hash: spec.hash, revision }, generatorVersion: o.version });
    const registryText = canonicalJson(registry);
    await write(registryFile, registryText);
    await write(join(support, 'openapi.snapshot.meta.json'), canonicalJson({ schemaVersion: 1, generatorVersion: o.version, specHash: spec.hash, source: spec.location, capturedRevision: revision }));
    const manifestFile = join(support, 'generation-manifest.json');
    const entries = [...hashes]
      .filter(([file]) => file !== registryFile && file !== manifestFile)
      .map(([file, sha256]) => {
        // API object subclasses are created once and belong to the user from then on.
        const handWritten = !py && /_support[\\/]api[\\/][^\\/]+Api\.ts$/.test(file);
        return [posix(relative(out, file)), { ownership: handWritten ? 'hand-written' : 'generated', sha256, ...(fileInfo.get(file) ?? {}) }] as const;
      });
    const manifest = { schemaVersion: 1, generatorVersion: o.version, spec: { hash: spec.hash, revision, source: spec.location }, caseRegistryHash: fileHash(registryText), files: Object.fromEntries(entries) };
    await write(manifestFile, canonicalJson(manifest));
  }
  return { files, removed, scenarios, coverage, cleanupFailures: [] };
}

/** The operation's x-api-test-agent-id, when the spec sets one. */
function externalIdOf(spec: LoadedSpec, op: Operation): string | undefined {
  const v = resolvePointer(spec.doc, operationPointer(op)).node?.['x-api-test-agent-id'];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

const firstLine = async (file: string) => (existsSync(file) ? (await readFile(file, 'utf8')).split('\n', 1)[0] : '');

/** A file written by the generator (its first line carries the generated header), never a hand-written one. */
async function isGenerated(file: string): Promise<boolean> {
  return /^(\/\/|""")\s*\S.* · \w+ cases\. Generated by api-test-agent /.test(await firstLine(file));
}

/** A resource helper written by the generator ("Data helpers for … Generated by api-test-agent"). */
async function isGeneratedHelper(file: string): Promise<boolean> {
  return /^(\/\/|""")\s*Data helpers for .*\. Generated by api-test-agent /.test(await firstLine(file));
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

async function runPytest(specs: Scenario[], runEnv: NodeJS.ProcessEnv, outDir: string): Promise<void> {
  const junit = resolve(outDir, 'pytest-junit.xml');
  await mkdir(dirname(junit), { recursive: true });
  const python = findPython();
  const args = ['-m', 'pytest', ...specs.map((s) => posix(relative(process.cwd(), s.file!))), '-q', '-p', 'no:cacheprovider', `--junitxml=${junit}`];
  const output = await new Promise<string>((done) => {
    const child = spawn(python, args, { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // The generated cleanup appends one JSON line per record it could not remove.
  const cleanupLog = resolve(outDir, 'cleanup-failures.jsonl');
  await mkdir(dirname(cleanupLog), { recursive: true });
  await rm(cleanupLog, { force: true });
  const casesOut = resolve(outDir, 'collected-cases.jsonl');
  await rm(casesOut, { force: true });
  const runEnv = { ...process.env, API_BASE_URL: env.baseUrl, API_AGENT_CLEANUP_LOG: cleanupLog, API_AGENT_CASES_OUT: casesOut };
  await (lang === 'python' ? runPytest(specs, runEnv, outDir) : runPlaywright(specs, runEnv, outDir));
  // Every physical test that ran (or was collected) must carry its own case ID from the registry.
  const collected = lang === 'python' ? await readCollected(casesOut) : await playwrightCaseIds(resolve(outDir, 'playwright-results.json'));
  const registryFile = result.files.find((f) => /[\\/]_support[\\/]cases\.json$/.test(f));
  const registered = registryFile && existsSync(registryFile) ? new Set(Object.keys(JSON.parse(await readFile(registryFile, 'utf8')).cases ?? {})) : new Set<string>();
  result.caseIdCheck = checkCaseIds(collected, registered);
  result.cleanupFailures = existsSync(cleanupLog)
    ? (await readFile(cleanupLog, 'utf8')).split('\n').filter((l) => l.trim()).flatMap((l) => {
        try {
          return [JSON.parse(l) as CleanupFailure];
        } catch {
          return [];
        }
      })
    : [];
}

export interface CaseIdCheck {
  tests: number;
  /** Tests without a case ID. */
  missing: string[];
  /** Case IDs carried by more than one physical test. */
  duplicates: string[];
  /** Case IDs that are not in _support/cases.json. */
  unregistered: string[];
}

export function checkCaseIds(tests: { test: string; caseId: string | null }[], registered: Set<string>): CaseIdCheck {
  const count = new Map<string, number>();
  for (const t of tests) if (t.caseId) count.set(t.caseId, (count.get(t.caseId) ?? 0) + 1);
  return {
    tests: tests.length,
    missing: tests.filter((t) => !t.caseId).map((t) => t.test),
    duplicates: [...count].filter(([, n]) => n > 1).map(([id]) => id),
    unregistered: [...count.keys()].filter((id) => !registered.has(id)),
  };
}

async function readCollected(file: string): Promise<{ test: string; caseId: string | null }[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Case IDs from the Playwright JSON report: the `caseId` annotation of every test. */
async function playwrightCaseIds(file: string): Promise<{ test: string; caseId: string | null }[]> {
  if (!existsSync(file)) return [];
  const report = JSON.parse(await readFile(file, 'utf8'));
  const out: { test: string; caseId: string | null }[] = [];
  const walk = (suite: any, file?: string) => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const annotations = [...(t.annotations ?? []), ...(t.results ?? []).flatMap((r: any) => r.annotations ?? [])];
        const id = annotations.find((a: any) => a.type === 'caseId')?.description ?? null;
        out.push({ test: `${f} › ${spec.title}`, caseId: id });
      }
    }
    for (const s of suite.suites ?? []) walk(s, f);
  };
  for (const s of report.suites ?? []) walk(s);
  return out;
}

/** Groups cleanup failures by operation and status: "DELETE /brands/{brandId} → 403: 13 record(s)". */
export function cleanupSummary(failures: CleanupFailure[]): string[] {
  const groups = new Map<string, number>();
  for (const f of failures) groups.set(`${f.operation} → ${f.status}`, (groups.get(`${f.operation} → ${f.status}`) ?? 0) + 1);
  return [...groups.entries()].map(([k, n]) => `${k}: ${n} record(s)`);
}

async function runPlaywright(specs: Scenario[], runEnv: NodeJS.ProcessEnv, outDir: string): Promise<void> {
  const jsonPath = resolve(outDir, 'playwright-results.json');
  await mkdir(dirname(jsonPath), { recursive: true });
  const cli = join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js');
  if (!existsSync(cli)) {
    for (const s of specs) s.reason = `${s.reason} Not run: @playwright/test is not installed in ${process.cwd()}.`;
    return;
  }
  const args = [cli, 'test', ...specs.map((s) => posix(relative(process.cwd(), s.file!))), '--reporter=json', '--workers=1'];
  const stdout = await new Promise<string>((done) => {
    const child = spawn(process.execPath, args, { env: { ...runEnv, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath }, stdio: ['ignore', 'pipe', 'pipe'] });
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
