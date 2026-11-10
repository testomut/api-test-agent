import type { Operation } from '../types.js';
import type { CrudChain } from './graph.js';
import type { NegCase } from './negative.js';
import { apiCall, type ApiRef } from './api-objects.js';
import type { SuiteCaseIds } from '../cases/assign.js';
import { requiredRequest, type ParamRequest } from './param-cases.js';
import type { ErrorPlan } from './error-cases.js';
import { varsIn, type ResolvedScenario, type ResolvedStep } from '../scenarios/dsl.js';
import { boundaryValues } from './boundaries.js';
import { tsCollectionImports, tsCollectionPrelude, tsCollectionTests, tsFixtureImport, tsFixtureTest, tsLifecycle, type CollectionInput } from './collection-render.js';
import type { LoadedFixture } from '../fixtures/fixtures.js';
import type { BodyVariant } from './variants.js';
import { tsVariantImports, tsVariantTests } from './variant-render.js';

/** Payloads and assumptions for one confirmed resource chain. */
export interface ChainPlan {
  chain: CrudChain;
  createPayload: unknown;
  createSources: string[];
  updatePayload?: unknown;
  updateSources: string[];
  /** String fields that get a per-call suffix because the operation documents 409 (field → maxLength or null). */
  uniqueCreate: Record<string, number | null>;
  uniqueUpdate: Record<string, number | null>;
  assumptions: string[];
}

/** The create payload reads values from existing data at run time (deps file "fill"). */
export const hasFill = (plan?: ChainPlan) => !!plan?.chain.fill?.length;

/** One comment line per payload whose fields are made unique, citing the documented 409. */
export function uniqueNote(op: Operation, fields: Record<string, number | null>, prefix: string): string[] {
  const names = Object.keys(fields);
  return names.length ? [`${prefix}${op.key} documents 409 (conflict): ${names.join(', ')} get a unique suffix on every call, so repeated runs do not collide.`] : [];
}

export interface Meta {
  spec: string;
  hash: string;
  version: string;
}

/** Folder layout: <resource>/<method>[-by-id]/{functional,contract,scenarios}.spec.ts */
export function operationFolder(op: Operation): { resource: string; action: string } {
  const segs = op.path.split('/').filter(Boolean);
  const statics = segs.filter((s) => !s.startsWith('{'));
  const resource = (statics.join('-') || 'root').replace(/[^\w.-]/g, '_');
  const byId = segs.length > 0 && segs[segs.length - 1].startsWith('{');
  return { resource, action: `${op.method}${byId ? '-by-id' : ''}` };
}

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const lit = (v: unknown) => JSON.stringify(v, null, 2);
const label = (op: Operation) => op.operationId ?? op.key;
const successCodes = (op: Operation) => op.responses.map((r) => r.status).filter((s) => /^2\d\d$/.test(s));

export function expectSuccess(op: Operation, v = 'res') {
  const ok = successCodes(op);
  return ok.length === 1
    ? `expect(${v}.status(), 'documented success status of ${label(op)}').toBe(${ok[0]});`
    : `expect([${ok.join(', ')}], 'documented success statuses of ${label(op)}').toContain(${v}.status());`;
}

function requiredQuery(op: Operation): Record<string, unknown> {
  return requiredRequest(op).params;
}

/**
 * Request options with the operation's required query / header / cookie parameters (documented values) merged in.
 * `inner` is an options literal such as "{ data: c.data }"; its own params / headers win.
 */
export function optionsWith(op: Operation, inner?: string): string | undefined {
  const req = requiredRequest(op);
  const body = inner ? inner.trim().replace(/^\{\s*/, '').replace(/\s*\}$/, '') : '';
  const fields: string[] = [];
  if (Object.keys(req.params).length && !/\bparams:/.test(body)) fields.push(`params: ${JSON.stringify(req.params)}`);
  if (Object.keys(req.headers).length && !/\bheaders:/.test(body)) fields.push(`headers: ${JSON.stringify(req.headers)}`);
  if (body) fields.push(body);
  return fields.length ? `{ ${fields.join(', ')} }` : undefined;
}

/** Safe query variations: only values explicitly allowed by the schema (enum values, else the valid limits). */
export function queryVariants(op: Operation): Array<{ name: string; value: string | number | boolean }> {
  if (op.method !== 'get') return [];
  return op.params.filter((p) => p.in === 'query' && !p.required).flatMap((p) => {
    const schema: any = p.schema ?? {};
    const values: unknown[] = Array.isArray(schema.enum) ? [...schema.enum] : [];
    // Boundary-valid values: the documented limits themselves must be accepted.
    if (!values.length) values.push(...boundaryValues(schema));
    const kept = values.filter((v): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
    // One physical test per value, each with its own case ID: values equal as strings would share an ID.
    const unique = kept.filter((v, i) => kept.findIndex((x) => String(x) === String(v)) === i);
    return unique.slice(0, 5).map((value) => ({ name: p.name, value }));
  }).slice(0, 15);
}

function header(kind: string, op: Operation, meta: Meta, extra: string[]): string[] {
  return [
    `// ${op.key} · ${kind} cases. Generated by api-test-agent ${meta.version}.`,
    `// Spec: ${meta.spec} (hash ${meta.hash}). Regenerated on spec change: put hand-written cases in separate files.`,
    `// Review before merging; never edit assertions just to make a test pass.`,
    ...extra.map((e) => `// ${e}`),
  ];
}

/* ------------------------------------------------------------------ helpers per resource */

/** Arguments for an API object method: path parameters in order; the chain parameter comes from `idVar`. */
export function pathArgs(op: Operation, ref: ApiRef, chainParam?: string, idVar = 'id'): string[] {
  return ref.pathParams.map((name) => {
    if (name === chainParam) return idVar;
    const p = op.params.find((x) => x.in === 'path' && x.name === name);
    return q(String(p?.knownValue));
  });
}

/** No credentials needed (no security, or an anonymous alternative): tested through publicApi. */
export const isPublic = (op: Operation) => op.security.length === 0 || op.security.some((a) => a.length === 0);
const apiFixture = (op: Operation) => (isPublic(op) ? 'publicApi' : 'api');

export function renderResourceHelpers(plan: ChainPlan, refs: Map<Operation, ApiRef>, meta: Meta): string {
  const { chain } = plan;
  const c = chain.create;
  const d = chain.delete!;
  const cr = refs.get(c)!;
  const dr = refs.get(d)!;
  const L = [
    `// Data helpers for ${chain.name}. Generated by api-test-agent ${meta.version}.`,
    `// Dependency source: ${chain.source}`,
    `// createPayload sources: ${plan.createSources.join('; ') || 'none'}`,
    ...(plan.updatePayload !== undefined ? [`// updatePayload sources: ${plan.updateSources.join('; ')}`] : []),
    `// Requests go through the API objects (_support/api): pass the test's \`api\` fixture.`,
    `import { expect, type APIResponse } from '@playwright/test';`,
    `import { expectContract, readPointer, reportCleanupFailure } from './contract-assert.js';`,
    `import type { Apis } from './api/generated/apis.js';`,
    '',
    `/** The documented example payloads, unchanged. Requests use newCreatePayload() / newUpdatePayload(). */`,
    `export const createPayload = ${lit(plan.createPayload)};`,
    '',
  ];
  if (plan.updatePayload !== undefined) L.push(`export const updatePayload = ${lit(plan.updatePayload)};`, '');
  L.push(
    `/** Copy of a payload with the given string fields suffixed (field → maxLength or null; the example is shortened to fit). */`,
    `function unique<T>(payload: T, fields: Record<string, number | null>): T {`,
    `  const out = structuredClone(payload) as Record<string, unknown>;`,
    `  const suffix = '-' + Math.random().toString(36).slice(2, 8).padEnd(6, '0');`,
    `  for (const [key, max] of Object.entries(fields)) {`,
    `    const value = out?.[key];`,
    `    if (typeof value === 'string') out[key] = (max === null ? value : value.slice(0, Math.max(0, max - suffix.length))) + suffix;`,
    `  }`,
    `  return out as T;`,
    `}`,
    '',
    ...uniqueNote(c, plan.uniqueCreate, '// '),
    ...(hasFill(plan)
      ? [
          `/** deps file "fill": ${chain.fill!.map((f) => f.field).join(', ')}: taken from existing data at run time, never created by the test. */`,
          `export async function newCreatePayload(api: Apis): Promise<Record<string, unknown>> {`,
          `  const payload: Record<string, unknown> = { ...unique(createPayload, ${JSON.stringify(plan.uniqueCreate)}) };`,
          ...chain.fill!.flatMap((f, i) => {
            const ref = refs.get(f.from!)!;
            const label = `${f.field} from ${f.from!.key} #${f.pointer}`;
            return [
              `  const source${i} = await ${apiCall(ref, 'api', pathArgs(f.from!, ref))};`,
              `  expect(source${i}.ok(), ${q(`${f.from!.key} answers (to fill ${f.field})`)}).toBe(true);`,
              `  payload[${q(f.field)}] = readPointer(await source${i}.json(), ${q(f.pointer)});`,
              `  expect(payload[${q(f.field)}] ?? undefined, ${q(`${label}: no existing data to use`)}).toBeDefined();`,
            ];
          }),
          `  return payload;`,
          `}`,
        ]
      : [`export const newCreatePayload = () => unique(createPayload, ${JSON.stringify(plan.uniqueCreate)});`]),
    ...(plan.updatePayload !== undefined ? [...uniqueNote(chain.update!, plan.uniqueUpdate, '// '), `export const newUpdatePayload = () => unique(updatePayload, ${JSON.stringify(plan.uniqueUpdate)});`] : []),
    '',
    `/** ${c.key}: creates a resource for a test and returns its id (at $response.body#${chain.idPointer}). */`,
    ...(hasFill(plan)
      ? [`export async function create(api: Apis, data?: unknown): Promise<{ id: string; body: unknown }> {`, `  data ??= await newCreatePayload(api);`]
      : [`export async function create(api: Apis, data: unknown = newCreatePayload()): Promise<{ id: string; body: unknown }> {`]),
    `  const res = await ${apiCall(cr, 'api', pathArgs(c, cr), '{ data }')};`,
    `  try {`,
    `    ${expectSuccess(c)}`,
    `    const body = await expectContract(res, '${c.method}', ${q(c.path)});`,
    `    const id = String(readPointer(body, ${q(chain.idPointer)}) ?? '');`,
    `    expect(id, 'identifier at $response.body#${chain.idPointer}').not.toBe('');`,
    `    return { id, body };`,
    `  } catch (error) {`,
    `    // The record may exist although a check failed (e.g. an undocumented 2xx status): remove it, then fail.`,
    `    await removeIfCreated(api, res);`,
    `    throw error;`,
    `  }`,
    `}`,
    '',
    `/** ${d.key}: best-effort cleanup, never fails the test. A record it cannot remove is reported (404 = already gone). */`,
    `export async function remove(api: Apis, id: string): Promise<void> {`,
    `  const res = await ${apiCall(dr, 'api', pathArgs(d, dr, chain.param))}.catch(() => undefined);`,
    `  if (!res || (!res.ok() && res.status() !== 404)) reportCleanupFailure(${q(d.key)}, id, res ? res.status() : 'no response');`,
    `}`,
    '',
    `/** Cleanup for negative create cases: if the API wrongly accepted the payload, delete what it created. */`,
    `export async function removeIfCreated(api: Apis, res: APIResponse): Promise<void> {`,
    `  if (!res.ok()) return;`,
    `  const id = readPointer(await res.json().catch(() => undefined), ${q(chain.idPointer)});`,
    `  if (id !== undefined && id !== null) await remove(api, String(id));`,
    `}`,
  );
  return L.join('\n') + '\n';
}

/* ------------------------------------------------------------------ suites: functional / contract / scenarios */

/** The three generated suite types; positive/negative is a separate axis (a tag), not a file. */
export type SuiteType = 'functional' | 'contract' | 'scenario';
export const SUITE_TYPES: SuiteType[] = ['functional', 'contract', 'scenario'];
export const TS_FILES: Record<SuiteType, string> = { functional: 'functional.spec.ts', contract: 'contract.spec.ts', scenario: 'scenarios.spec.ts' };

/** Everything the generator decided for one operation; each renderer picks its own cases. */
export interface SuiteInput {
  op: Operation;
  refs: Map<Operation, ApiRef>;
  plan?: ChainPlan; // set when the operation belongs to a confirmed chain
  helpers?: string; // import path of the resource helpers
  positive: boolean; // a successful call can be sent safely
  validation: string[]; // documented validation rejections: 400 / 422 / 4XX
  bodyCases: NegCase[];
  paramCases: NegCase[];
  notFound?: { idExpr: string; param: string };
  unauthorized: boolean;
  /** Stable case IDs of this operation's tests (Playwright annotation caseId, pytest marker api_case_id). */
  ids?: SuiteCaseIds;
  /** Documented error responses with a safe trigger (stage 6). */
  errors?: ErrorPlan;
  /** Reviewed business scenarios whose primary step is this operation (stage 8). */
  business?: ResolvedScenario[];
  /** A list operation with a reviewed "collection" mapping: deep collection tests and the list lifecycle. */
  collection?: CollectionInput;
  /** An approved fixture of this list operation (strategy B). */
  fixture?: LoadedFixture;
  /** Positive request-body variants of a create / update (only required fields, other oneOf / anyOf branches). */
  bodyVariants?: BodyVariant[];
}

export type Role = 'create' | 'read' | 'update' | 'delete';

export function roleOf(op: Operation, plan?: ChainPlan): Role | undefined {
  const c = plan?.chain;
  if (!c) return undefined;
  return c.create === op ? 'create' : c.read === op ? 'read' : c.update === op ? 'update' : c.delete === op ? 'delete' : undefined;
}

/** Multi-request scenarios whose primary operation is `op` (the action under test, never the setup step). */
export function scenarioCases(s: Pick<SuiteInput, 'op' | 'plan' | 'positive' | 'errors'>): { createRead: boolean; updateRead: boolean; deleteGone: boolean; conflict: boolean; deleteTwice: boolean } {
  const role = roleOf(s.op, s.plan);
  const read = s.plan?.chain.read;
  return {
    deleteTwice: s.positive && role === 'delete' && s.op.responses.some((r) => r.status === '404'),
    conflict: s.positive && role === 'create' && !!s.errors?.conflict,
    createRead: s.positive && role === 'create' && !!read,
    updateRead: s.positive && role === 'update' && !!read && s.plan!.updatePayload !== undefined,
    deleteGone: s.positive && role === 'delete' && !!read && read.responses.some((r) => r.status === '404'),
  };
}

/** Number of cases per suite type; a file is written only when its count is above zero. */
export function suiteCounts(s: SuiteInput): Record<SuiteType, number> {
  const extra = (s.notFound ? 1 : 0) + (s.unauthorized ? 1 : 0);
  const sc = scenarioCases(s);
  const e = s.errors;
  const base = {
    functional: (s.positive ? 1 : 0) + extra + (s.positive && !s.plan ? queryVariants(s.op).length : 0) + (e?.invalidCredentials ? 1 : 0) + (e?.envCredentials?.length ?? 0) + (e?.methodNotAllowed ? 1 : 0) + (e?.preconditionFailed && s.plan ? 1 : 0),
    contract: (s.positive ? 1 : 0) + extra + s.bodyCases.length + s.paramCases.length + (e?.unsupportedMediaType && s.plan ? 1 : 0),
  };
  return {
    contract: base.contract,
    functional: base.functional + (s.collection?.plan.tests.length ?? 0) + (s.fixture ? 1 : 0) + (s.bodyVariants?.length ?? 0),
    scenario: (sc.createRead ? 1 : 0) + (sc.updateRead ? 1 : 0) + (sc.deleteGone ? 1 : 0) + (sc.conflict ? 1 : 0) + (sc.deleteTwice ? 1 : 0) + (s.business?.length ?? 0) + (s.collection?.plan.lifecycle ? 1 : 0),
  };
}

/** Test options: the polarity tag and, when known, the stable case ID as a Playwright annotation. */
export const testOptions = (polarity: 'positive' | 'negative', id?: string) =>
  id ? `{ tag: '@${polarity}', annotation: { type: 'caseId', description: ${q(id)} } }` : `{ tag: '@${polarity}' }`;
const POS = testOptions('positive');
const NEG = testOptions('negative');

function suiteHeader(suite: SuiteType, s: SuiteInput, meta: Meta, extra: string[]): string[] {
  const chain = s.plan?.chain;
  const lines = [...extra];
  if (chain) lines.unshift(`Preconditions and cleanup: ${chain.source}`);
  if (!chain && isPublic(s.op)) lines.push('Public operation (no security in the spec): sent without credentials through publicApi.');
  lines.push('Polarity is a tag: run one side with --grep @positive or --grep @negative.');
  return header(suite, s.op, meta, lines);
}

/**
 * The successful call of the operation with its precondition and cleanup.
 * `assert` receives the response variable and returns the assertion lines (functional or contract).
 */
function positiveTest(s: SuiteInput, title: string, assert: (indent: string) => string[], id?: string): string[] {
  const { op, refs, plan } = s;
  const POS = testOptions('positive', id);
  const chain = plan?.chain;
  const role = roleOf(op, plan);
  const ref = refs.get(op)!;
  const call = (idVar?: string, options?: string) => apiCall(ref, 'api', pathArgs(op, ref, chain?.param, idVar), optionsWith(op, options));
  if (!role) {
    const opts = optionsWith(op);
    const fx = apiFixture(op);
    return [
      `  test(${q(title)}, ${POS}, async ({ ${fx} }) => {`,
      `    const res = await ${apiCall(ref, fx, pathArgs(op, ref), opts)};`,
      ...assert('    '),
      `  });`,
    ];
  }
  if (role === 'create') {
    return [
      `  test(${q(title)}, ${POS}, async ({ api }) => {`,
      `    const payload = ${hasFill(plan) ? 'await resource.newCreatePayload(api)' : 'resource.newCreatePayload()'};`,
      `    const res = await ${call('id', '{ data: payload }')};`,
      `    try {`,
      ...assert('      '),
      `    } finally {`,
      `      await resource.removeIfCreated(api, res);`,
      `    }`,
      `  });`,
    ];
  }
  const body = role === 'update' ? '{ data: resource.newUpdatePayload() }' : undefined;
  return [
    `  test(${q(title)}, ${POS}, async ({ api }) => {`,
    `    const { id } = await resource.create(api);`,
    `    try {`,
    `      const res = await ${call('id', body)};`,
    ...assert('      '),
    `    } finally {`,
    `      await resource.remove(api, id); // best effort: a deleted resource is already gone`,
    `    }`,
    `  });`,
  ];
}

function imports(s: SuiteInput, names: string[], usesHelpers: boolean, missingIds = true): string[] {
  const L: string[] = [];
  if (missingIds && s.notFound?.idExpr === 'randomUUID()') L.push(`import { randomUUID } from 'node:crypto';`);
  L.push(`import { test${names.includes('expect') ? ', expect' : ''} } from '../../_support/fixtures.js';`);
  const support = names.filter((n) => n !== 'expect');
  if (support.length) L.push(`import { ${support.join(', ')} } from '../../_support/contract-assert.js';`);
  if (usesHelpers) L.push(`import * as resource from '${s.helpers}';`);
  return L;
}

/** The request to a missing id / without credentials: shared by functional (status) and contract (schema). */
function notFoundCall(s: SuiteInput, fx: string): string[] {
  const { op, refs, plan } = s;
  const ref = refs.get(op)!;
  const chain = plan?.chain;
  const body = plan?.updatePayload !== undefined && chain?.update === op ? `{ data: resource.newUpdatePayload() }` : undefined;
  return [`    const missingId = String(${s.notFound!.idExpr});`, `    const res = await ${apiCall(ref, fx, pathArgs(op, ref, chain?.param ?? s.notFound!.param, 'missingId'), optionsWith(op, body))};`];
}
const anonymousCall = (s: SuiteInput) => {
  const ref = s.refs.get(s.op)!;
  return `    const res = await ${apiCall(ref, 'publicApi', pathArgs(s.op, ref, s.plan?.chain.param, "'unused'"), optionsWith(s.op))};`;
};
const notFoundNeedsHelpers = (s: SuiteInput) => !!s.notFound && s.plan?.updatePayload !== undefined && s.plan.chain.update === s.op;

/** functional.spec.ts: the endpoint does its job (expected status and result); documented 404/401 as behavior. */
export function renderFunctional(s: SuiteInput, meta: Meta): string {
  const { op, plan } = s;
  const chain = plan?.chain;
  const role = roleOf(op, plan);
  const fx = chain ? 'api' : apiFixture(op);
  const usesHelpers = (s.positive && !!role) || notFoundNeedsHelpers(s) || !!(s.errors?.preconditionFailed && plan) || !!s.collection?.plan.tests.length || !!s.bodyVariants?.length;
  const errorStatus = !!(s.errors?.invalidCredentials || s.errors?.envCredentials?.length || s.errors?.methodNotAllowed || s.errors?.preconditionFailed);
  const coll = s.collection?.plan.tests.length ? s.collection : undefined;
  const names = [...new Set(['expect', ...(s.positive && (role === 'create' || role === 'read') ? ['readPointer'] : []), ...(s.notFound || s.unauthorized || errorStatus ? ['expectStatus'] : []), ...(coll ? tsCollectionImports('functional') : []), ...(s.fixture ? ['itemsOf', 'expectMatchesFixture'] : []), ...tsVariantImports(s)])];
  const L = suiteHeader('functional', s, meta, ['Checks the behavior of the endpoint: status and result. The response schema is checked in contract.spec.ts.', ...(coll ? ['Collection checks run on records the tests create (controlled datasets) or, where marked read-only, on existing data.'] : [])]);
  L.push(...imports(s, names, usesHelpers), ...(s.fixture ? [tsFixtureImport(s.fixture)] : []), ...(coll ? ['', ...tsCollectionPrelude(s, coll)] : ['']), `test.describe('${op.key} · functional', { tag: '@functional' }, () => {`);

  if (s.positive) {
    const titles: Record<string, string> = {
      none: 'returns the documented success status',
      create: 'creates a resource from the documented example payload',
      read: 'returns the resource created in the precondition',
      update: 'applies the documented example update',
      delete: 'deletes the resource created in the precondition',
    };
    L.push(
      ...positiveTest(s, titles[role ?? 'none'], (i) => {
        const a = [`${i}${expectSuccess(op)}`];
        if (role === 'create') {
          a.push(`${i}const created = await res.json().catch(() => undefined);`, `${i}const id = readPointer(created, ${q(chain!.idPointer)});`, `${i}expect(String(id ?? ''), 'identifier at $response.body#${chain!.idPointer}').not.toBe('');`);
          // Fields a reviewed deps file says the create response returns as sent.
          for (const field of chain!.echoes ?? []) a.push(`${i}expect(readPointer(created, ${q('/' + field.replace(/~/g, '~0').replace(/\//g, '~1'))}), ${q(`${field} returned as sent`)}).toEqual((payload as Record<string, unknown>)[${q(field)}]);`);
        }
        if (role === 'read') a.push(`${i}expect(String(readPointer(await res.json().catch(() => undefined), ${q(chain!.idPointer)})), 'same resource').toBe(id);`);
        return a;
      }, s.ids?.functional.success),
      '',
    );
  }
  if (s.positive && !plan && op.method === 'get') {
    const ref = s.refs.get(op)!;
    const base = requiredQuery(op);
    queryVariants(op).forEach((variant, n) => {
      const params = { ...base, [variant.name]: variant.value };
      L.push(
        `  test(${q(`accepts documented ${variant.name}=${String(variant.value)}`)}, ${testOptions('positive', s.ids?.functional.variants[n])}, async ({ ${fx} }) => {`,
        `    const res = await ${apiCall(ref, fx, pathArgs(op, ref), optionsWith(op, `{ params: ${JSON.stringify(params)} }`))};`,
        `    ${expectSuccess(op)}`,
        `  });`,
        '',
      );
    });
  }
  if (s.notFound) {
    L.push(`  test('returns documented 404 for an id that does not exist', ${testOptions('negative', s.ids?.functional.notFound)}, async ({ ${fx} }) => {`, ...notFoundCall(s, fx), `    expectStatus(res, ['404'], '${op.method}', ${q(op.path)});`, `  });`, '');
  }
  if (s.unauthorized) {
    // publicApi sends no credentials at all (not even the project's static token).
    L.push(`  test('returns documented 401 without credentials', ${testOptions('negative', s.ids?.functional.unauthorized)}, async ({ publicApi }) => {`, anonymousCall(s), `    expectStatus(res, ['401'], '${op.method}', ${q(op.path)});`, `  });`, '');
  }
  L.push(...errorTests(s));
  if (coll) L.push(...tsCollectionTests(s, coll));
  if (s.fixture) L.push(...tsFixtureTest(s, s.fixture));
  if (s.bodyVariants?.length) L.push(...tsVariantTests(s));
  return close(L);
}

/** A reviewed business scenario: its steps in order, saved values, expected statuses; cleanup steps in finally. */
function businessTest(s: SuiteInput, sc: ResolvedScenario, id?: string): string[] {
  const L: string[] = [];
  const pol = sc.polarity;
  L.push(`  test(${q(sc.title)}, ${testOptions(pol, id)}, async ({ api }) => {`, `    const vars: Record<string, unknown> = {};`);
  const callOf = (st: ResolvedStep, v: string, indent: string) => {
    const ref = s.refs.get(st.op)!;
    const req = requiredRequest(st.op);
    const args = ref.pathParams.map((name) => {
      const given = st.params?.[name];
      if (given !== undefined) return `String(fillVars(${JSON.stringify(given)}, vars))`;
      return q(String(st.op.params.find((x) => x.in === 'path' && x.name === name)?.knownValue));
    });
    const query = Object.fromEntries(Object.entries(st.params ?? {}).filter(([k]) => st.op.params.some((x) => x.in === 'query' && x.name === k)));
    const opts = [
      Object.keys(query).length || Object.keys(req.params).length ? `params: { ...${JSON.stringify(req.params)}, ...fillVars(${JSON.stringify(query)}, vars) }` : '',
      Object.keys(req.headers).length ? `headers: ${JSON.stringify(req.headers)}` : '',
      st.body !== undefined ? `data: fillVars(${JSON.stringify(st.body)}, vars)` : '',
    ].filter(Boolean);
    return `${indent}const ${v} = await ${apiCall(ref, 'api', args, opts.length ? `{ ${opts.join(', ')} }` : undefined)};`;
  };
  const main = sc.steps.filter((st) => st.phase !== 'cleanup');
  const cleanup = sc.steps.filter((st) => st.phase === 'cleanup');
  L.push(`    try {`);
  main.forEach((st, j) => {
    L.push(`      // ${st.phase}${st.name ? ` ${st.name}` : ''}: ${st.op.key}`, callOf(st, `res${j}`, '      '));
    if (st.expect) L.push(`      expectStatus(res${j}, [${q(String(st.expect))}], '${st.op.method}', ${q(st.op.path)});`);
    if (Object.keys(st.save ?? {}).length) {
      L.push(`      const body${j} = await res${j}.json().catch(() => undefined);`);
      for (const [name, ptr] of Object.entries(st.save ?? {})) L.push(`      vars[${q(name)}] = readPointer(body${j}, ${q(ptr)});`);
    }
  });
  L.push(`    } finally {`);
  cleanup.forEach((st, j) => {
    const needs = varsIn([st.params, st.body]);
    const guard = needs.length ? needs.map((v) => `vars[${q(v)}] !== undefined`).join(' && ') : 'true';
    L.push(
      `      if (${guard}) {`,
      callOf(st, `clean${j}`, '        ').replace(/;$/, '.catch(() => undefined);'),
      `        if (!clean${j} || (!clean${j}.ok() && clean${j}.status() !== 404)) reportCleanupFailure(${q(st.op.key)}, String(${needs.length ? `vars[${q(needs[0])}]` : "''"}), clean${j} ? clean${j}.status() : 'no response');`,
      `      }`,
    );
  });
  L.push(`    }`, `  });`, '');
  return L;
}

/** Documented error responses with a safe trigger (stage 6): invalid credentials, 405, 412. */
function errorTests(s: SuiteInput): string[] {
  const { op, plan } = s;
  const e = s.errors;
  if (!e) return [];
  const ref = s.refs.get(op)!;
  const req = requiredRequest(op);
  const L: string[] = [];
  if (e.invalidCredentials) {
    const params = { ...req.params, ...e.invalidCredentials.params };
    const headers = { ...req.headers, ...e.invalidCredentials.headers };
    const opts = [Object.keys(params).length ? `params: ${JSON.stringify(params)}` : '', `headers: ${JSON.stringify(headers)}`].filter(Boolean).join(', ');
    // publicApi carries no credentials of its own: only the invalid one is sent.
    L.push(
      `  test('returns documented 401 for invalid credentials', ${testOptions('negative', s.ids?.functional.invalidCredentials)}, async ({ publicApi }) => {`,
      `    const res = await ${apiCall(ref, 'publicApi', pathArgs(op, ref, plan?.chain.param, "'unused'"), `{ ${opts} }`)};`,
      `    expectStatus(res, ['401'], '${op.method}', ${q(op.path)});`,
      `  });`,
      '',
    );
  }
  (e.envCredentials ?? []).forEach((c, n) => {
    // The credential comes from the environment at run time (a reviewed deps "auth" entry names the variable).
    const params = { ...req.params };
    const headers = { ...req.headers };
    const cred = `${q(c.prefix)} + credential`;
    const opts = [
      c.query ? `params: { ...${JSON.stringify(params)}, ${q(c.query)}: ${cred} }` : Object.keys(params).length ? `params: ${JSON.stringify(params)}` : '',
      c.header ? `headers: { ...${JSON.stringify(headers)}, ${q(c.header)}: ${cred} }` : Object.keys(headers).length ? `headers: ${JSON.stringify(headers)}` : '',
    ].filter(Boolean).join(', ');
    const args = c.knownPath ? pathArgs(op, ref) : pathArgs(op, ref, plan?.chain.param, "'unused'");
    const what = c.kind === 'expired' ? 'an expired credential' : 'an account that must be refused';
    L.push(
      `  test(${q(`returns documented ${c.status} for ${what} (${c.env})`)}, ${testOptions('negative', s.ids?.functional.envCredentials?.[n])}, async ({ publicApi }) => {`,
      `    const credential = process.env.${c.env} ?? '';`,
      `    test.skip(!credential, ${q(`${c.env} is not set: the reviewed ${c.kind === 'expired' ? 'expired credential (deps auth.expired)' : 'refused account (deps auth.forbidden)'} is not available`)});`,
      `    const res = await ${apiCall(ref, 'publicApi', args, `{ ${opts} }`)};`,
      `    expectStatus(res, ['${c.status}'], '${op.method}', ${q(op.path)});`,
      `  });`,
      '',
    );
  });
  if (e.methodNotAllowed) {
    const path = op.path.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(String(op.params.find((p) => p.in === 'path' && p.name === name)?.knownValue ?? 'unused')));
    // GET is the only method that is safe to send to a route the spec does not define.
    L.push(
      `  test('answers documented 405 to a method the path does not define (GET)', ${testOptions('negative', s.ids?.functional.methodNotAllowed)}, async ({ request }) => {`,
      `    const res = await request.get(${q(path.replace(/^\//, ''))});`,
      `    expectStatus(res, ['405'], '${op.method}', ${q(op.path)});`,
      `  });`,
      '',
    );
  }
  if (e.preconditionFailed && plan) {
    const headers = { ...req.headers, [e.preconditionFailed.header]: e.preconditionFailed.value };
    const data = plan.chain.update === op ? ', data: resource.newUpdatePayload()' : '';
    const params = Object.keys(req.params).length ? `params: ${JSON.stringify(req.params)}, ` : '';
    L.push(
      `  test('returns documented 412 when ${e.preconditionFailed.header} does not match', ${testOptions('negative', s.ids?.functional.preconditionFailed)}, async ({ api }) => {`,
      `    const { id } = await resource.create(api);`,
      `    try {`,
      `      const res = await ${apiCall(ref, 'api', pathArgs(op, ref, plan.chain.param, 'id'), `{ ${params}headers: ${JSON.stringify(headers)}${data} }`)};`,
      `      expectStatus(res, ['412'], '${op.method}', ${q(op.path)});`,
      `    } finally {`,
      `      await resource.remove(api, id);`,
      `    }`,
      `  });`,
      '',
    );
  }
  return L;
}

const caseField = (id?: string) => (id ? `caseId: ${q(id)}, ` : '');
/** A data-driven test: the case ID comes from the row when every row has one. */
const loopOptions = (ids?: string[]) => (ids?.length && ids.every(Boolean) ? `{ tag: '@negative', annotation: { type: 'caseId', description: c.caseId } }` : NEG);

/** contract.spec.ts: responses match OpenAPI (documented status, content type, schema); invalid requests are rejected as documented. */
export function renderContract(s: SuiteInput, meta: Meta): string {
  const { op, plan } = s;
  const chain = plan?.chain;
  const role = roleOf(op, plan);
  const ref = s.refs.get(op)!;
  const isCreate = chain?.create === op;
  const needsExisting = !!chain && chain.create !== op && op.params.some((p) => p.in === 'path' && p.name === chain.param);
  const wrongMedia = !!(s.errors?.unsupportedMediaType && chain);
  const invalid = s.bodyCases.length + s.paramCases.length > 0 || wrongMedia;
  const usesHelpers = (s.positive && !!role) || notFoundNeedsHelpers(s) || (s.bodyCases.length > 0 && !!chain && (isCreate || needsExisting)) || wrongMedia;
  // Validation cases go through the same fixture as the positive test (anonymous for public operations).
  const fx = chain ? 'api' : apiFixture(op);
  const names = [...(s.positive || s.notFound || s.unauthorized ? ['expectContract'] : []), ...(invalid ? ['expectRejected'] : [])];
  const L = suiteHeader('contract', s, meta, ['Checks conformance to the OpenAPI document: the status actually returned is documented and the body matches its schema.', 'Invalid requests break one documented constraint each and must get a documented rejection.']);
  L.push(...imports(s, names, usesHelpers));
  if (s.bodyCases.length + s.paramCases.length > 0) L.push('', `const rejection = ${JSON.stringify(s.validation)}; // documented in the spec`);
  L.push('', `test.describe('${op.key} · contract', { tag: '@contract' }, () => {`);

  const contract = (i: string, v = 'res') => [`${i}await expectContract(${v}, '${op.method}', ${q(op.path)});`];
  if (s.positive) L.push(...positiveTest(s, 'success response matches the documented contract', (i) => contract(i), s.ids?.contract.success), '');
  if (s.notFound) L.push(`  test('response for a missing id matches the documented contract', ${testOptions('positive', s.ids?.contract.notFound)}, async ({ ${fx} }) => {`, ...notFoundCall(s, fx), ...contract('    '), `  });`, '');
  if (s.unauthorized) L.push(`  test('response without credentials matches the documented contract', ${testOptions('positive', s.ids?.contract.unauthorized)}, async ({ publicApi }) => {`, anonymousCall(s), ...contract('    '), `  });`, '');

  const send = (indent: string, options: string) => `${indent}const res = await ${apiCall(ref, fx, pathArgs(op, ref, chain?.param, 'id'), optionsWith(op, options))};`;
  if (s.bodyCases.length) {
    L.push(`  const invalidBodies = [`);
    s.bodyCases.forEach((c, n) => L.push(`    { title: ${q(c.title)}, source: ${q(c.source)}, ${caseField(s.ids?.contract.body[n])}data: ${JSON.stringify(c.data)} },`));
    L.push(`  ];`, '', `  for (const c of invalidBodies) {`, `    test(\`rejects invalid body: \${c.title}\`, ${loopOptions(s.ids?.contract.body)}, async ({ ${fx} }) => {`);
    if (needsExisting) {
      L.push(`      const { id } = await resource.create(${fx});`, `      try {`, send('        ', '{ data: c.data }'));
      L.push(`        await expectRejected(res, rejection, '${op.method}', ${q(op.path)});`, `      } finally {`, `        await resource.remove(${fx}, id);`, `      }`);
    } else {
      L.push(send('      ', '{ data: c.data }'));
      if (isCreate) L.push(`      await resource.removeIfCreated(${fx}, res);`);
      L.push(`      await expectRejected(res, rejection, '${op.method}', ${q(op.path)});`);
    }
    L.push(`    });`, `  }`, '');
  }
  if (s.paramCases.length) {
    // Each row is a whole request: the valid required parameters plus the one parameter under test.
    L.push(`  const invalidParameters: { title: string; source: string; caseId?: string; params?: Record<string, string | number | boolean> | string; headers?: Record<string, string>; path?: Record<string, string> }[] = [`);
    s.paramCases.forEach((c, n) => {
      const r: ParamRequest = c.request ?? (c.query ? { params: c.query as ParamRequest['params'] } : {});
      const fields = [r.params !== undefined ? `params: ${JSON.stringify(r.params)}` : '', r.headers ? `headers: ${JSON.stringify(r.headers)}` : '', r.path ? `path: ${JSON.stringify(r.path)}` : ''].filter(Boolean).join(', ');
      L.push(`    { title: ${q(c.title)}, source: ${q(c.source)}, ${caseField(s.ids?.contract.params[n])}${fields} },`);
    });
    const args = ref.pathParams.map((name) => {
      const known = op.params.find((x) => x.in === 'path' && x.name === name)?.knownValue;
      return `c.path?.[${q(name)}] ?? ${known === undefined ? "'unused'" : q(String(known))}`;
    });
    L.push(`  ];`, '', `  for (const c of invalidParameters) {`, `    test(\`rejects invalid parameter: \${c.title}\`, ${loopOptions(s.ids?.contract.params)}, async ({ ${fx} }) => {`);
    L.push(`      const res = await ${apiCall(ref, fx, args, '{ params: c.params, headers: c.headers }')};`, `      await expectRejected(res, rejection, '${op.method}', ${q(op.path)});`, `    });`, `  }`, '');
  }
  if (wrongMedia) {
    // 415: the documented body, but declared as text/plain. Anything the API wrongly creates is removed.
    const req = requiredRequest(op);
    const headers = JSON.stringify({ ...req.headers, 'content-type': 'text/plain' });
    const params = Object.keys(req.params).length ? `params: ${JSON.stringify(req.params)}, ` : '';
    const payload = isCreate ? (hasFill(plan) ? 'await resource.newCreatePayload(api)' : 'resource.newCreatePayload()') : 'resource.newUpdatePayload()';
    const opts = `{ ${params}headers: ${headers}, data: JSON.stringify(${payload}) }`;
    L.push(`  test('rejects a body sent as text/plain with documented 415', ${testOptions('negative', s.ids?.contract.unsupportedMediaType)}, async ({ api }) => {`);
    if (isCreate) L.push(`    const res = await ${apiCall(ref, 'api', pathArgs(op, ref), opts)};`, `    await resource.removeIfCreated(api, res);`, `    await expectRejected(res, ['415'], '${op.method}', ${q(op.path)});`);
    else L.push(`    const { id } = await resource.create(api);`, `    try {`, `      const res = await ${apiCall(ref, 'api', pathArgs(op, ref, chain!.param, 'id'), opts)};`, `      await expectRejected(res, ['415'], '${op.method}', ${q(op.path)});`, `    } finally {`, `      await resource.remove(api, id);`, `    }`);
    L.push(`  });`, '');
  }
  return close(L);
}

/** scenarios.spec.ts: multi-request flows whose primary (action under test) is this operation. */
export function renderScenarios(s: SuiteInput, meta: Meta): string {
  const { op, refs, plan } = s;
  // CRUD flows need the confirmed chain; reviewed business scenarios (--scenarios) do not.
  const chain = plan?.chain as CrudChain;
  const r = chain?.read as Operation;
  const business = s.business ?? [];
  const sc = scenarioCases(s);
  const call = (o: Operation, options?: string) => {
    const ref = refs.get(o)!;
    return apiCall(ref, 'api', pathArgs(o, ref, chain.param, 'id'), options);
  };
  const extra = plan ? ['Each scenario: setup (create) → action (this operation) → assertion (read) → cleanup (delete).'] : [];
  if (business.length) extra.push('Business scenarios come from the reviewed scenarios file: steps, expected statuses and cleanup as written there.');
  if (sc.updateRead) extra.push(`ASSUMPTION (not in spec, reviewer must confirm): ${plan!.assumptions.find((a) => a.startsWith('after')) ?? 'read after update returns the new values'}`);
  const L = suiteHeader('scenario', s, meta, extra);
  const life = s.collection?.plan.lifecycle ? s.collection : undefined;
  const names = [...new Set(['expect', ...(sc.createRead || business.length ? ['readPointer'] : []), ...(sc.conflict || sc.deleteTwice || business.length ? ['expectStatus'] : []), ...(business.length ? ['fillVars', 'reportCleanupFailure'] : []), ...(life ? tsCollectionImports('scenario') : [])])];
  L.push(...imports(s, names, !!plan || !!life, false), ...(life ? ['', ...tsCollectionPrelude(s, life)] : ['']), `test.describe('${op.key} · scenarios', { tag: '@scenario' }, () => {`);
  if (life) L.push(...tsLifecycle(s, life));
  if (sc.deleteTwice) {
    // A repeated delete of the same resource gets the documented 404.
    L.push(
      `  test('deleting the same resource again gets the documented 404', ${testOptions('negative', s.ids?.scenario.deleteTwice)}, async ({ api }) => {`,
      `    const { id } = await resource.create(api);`,
      `    try {`,
      `      const first = await ${call(op, optionsWith(op))};`,
      `      ${expectSuccess(op, 'first')}`,
      `      const res = await ${call(op, optionsWith(op))};`,
      `      expectStatus(res, ['404'], '${op.method}', ${q(op.path)});`,
      `    } finally {`,
      `      await resource.remove(api, id);`,
      `    }`,
      `  });`,
      '',
    );
  }
  if (sc.conflict) {
    // 409 on the fields a reviewed deps file names: the same payload twice. Both records are removed.
    const fields = s.errors!.conflict!.fields;
    const payload = hasFill(plan) ? 'await resource.newCreatePayload(api)' : 'resource.newCreatePayload()';
    L.push(
      `  test(${q(`a second create with the same ${fields.join(', ')} gets the documented 409`)}, ${testOptions('negative', s.ids?.scenario.conflict)}, async ({ api }) => {`,
      `    const payload = ${payload};`,
      `    const first = await resource.create(api, payload);`,
      `    try {`,
      `      const res = await ${call(op, optionsWith(op, '{ data: payload }'))};`,
      `      try {`,
      `        expectStatus(res, ['409'], '${op.method}', ${q(op.path)});`,
      `      } finally {`,
      `        await resource.removeIfCreated(api, res);`,
      `      }`,
      `    } finally {`,
      `      await resource.remove(api, first.id);`,
      `    }`,
      `  });`,
      '',
    );
  }
  if (sc.createRead) {
    L.push(
      `  test('the created resource can be retrieved by ${r.operationId ?? r.key}', ${testOptions('positive', s.ids?.scenario.createRead)}, async ({ api }) => {`,
      `    const { id } = await resource.create(api);`,
      `    try {`,
      `      const read = await ${call(r)};`,
      `      ${expectSuccess(r, 'read')}`,
      `      const body = await read.json();`,
      `      expect(String(readPointer(body, ${q(chain.idPointer)}) ?? ''), 'created resource id').toBe(id);`,
      `    } finally {`,
      `      await resource.remove(api, id);`,
      `    }`,
      `  });`,
      '',
    );
  }
  if (sc.updateRead) {
    L.push(
      `  test('the update is visible through ${r.operationId ?? r.key}', ${testOptions('positive', s.ids?.scenario.updateRead)}, async ({ api }) => {`,
      `    const { id } = await resource.create(api);`,
      `    try {`,
      `      const payload = resource.newUpdatePayload();`,
      `      const res = await ${call(op, '{ data: payload }')};`,
      `      ${expectSuccess(op)}`,
      `      // ASSUMPTION: the read operation returns the updated values.`,
      `      const read = await ${call(r)};`,
      `      ${expectSuccess(r, 'read')}`,
      `      expect(await read.json()).toMatchObject(payload);`,
      `    } finally {`,
      `      await resource.remove(api, id);`,
      `    }`,
      `  });`,
      '',
    );
  }
  if (sc.deleteGone) {
    L.push(
      `  test('the deleted resource is no longer returned by ${r.operationId ?? r.key}', ${testOptions('positive', s.ids?.scenario.deleteGone)}, async ({ api }) => {`,
      `    const { id } = await resource.create(api);`,
      `    try {`,
      `      const res = await ${call(op)};`,
      `      ${expectSuccess(op)}`,
      `      const read = await ${call(r)};`,
      `      expect(read.status(), 'documented 404 after delete').toBe(404);`,
      `    } finally {`,
      `      await resource.remove(api, id); // best effort: normally already gone`,
      `    }`,
      `  });`,
      '',
    );
  }
  L.push(...business.flatMap((sc2, n) => businessTest(s, sc2, s.ids?.scenario.business[n])));
  return close(L);
}

function close(L: string[]): string {
  if (L[L.length - 1] === '') L.pop();
  L.push(`});`);
  return L.join('\n') + '\n';
}

/* ------------------------------------------------------------------ shared support */

export const CONTRACT_ASSERT = `// Generated by api-test-agent. Bridges Playwright responses to the OpenAPI contract.
import { appendFileSync } from 'node:fs';
import { expect, test, type APIResponse } from '@playwright/test';
import { ContractValidator } from './contract.js';
import { spec } from './openapi.snapshot.js';

const validator = new ContractValidator(spec);

/**
 * Test data that cleanup could not remove (it stays on the target). Never fails the test:
 * the agent sets API_AGENT_CLEANUP_LOG and lists these in its report; a standalone run prints a warning.
 */
export function reportCleanupFailure(operation: string, id: string, status: number | string): void {
  const file = process.env.API_AGENT_CLEANUP_LOG;
  if (file) appendFileSync(file, JSON.stringify({ operation, id, status }) + '\\n');
  else console.warn(\`cleanup failed: \${operation} \${id} → \${status} (test data left on the target)\`);
}

async function readBody(res: APIResponse): Promise<{ contentType: string | null; body: unknown; rawText: string }> {
  const contentType = res.headers()['content-type'] ?? null;
  const rawText = await res.text();
  let body: unknown = rawText;
  if (contentType?.includes('json')) {
    try {
      body = rawText.length ? JSON.parse(rawText) : null;
    } catch {
      body = undefined;
    }
  }
  return { contentType, body, rawText };
}

/**
 * Validates status, headers, content type and body against the spec. Failures are tagged CONTRACT_MISMATCH.
 * What could not be checked (e.g. a media type without a schema) is added to the test report as a note.
 */
export async function expectContract(res: APIResponse, method: string, path: string): Promise<unknown> {
  const { contentType, body, rawText } = await readBody(res);
  const r = validator.validateResponse({ method, path, status: res.status(), contentType, body, rawText, headers: res.headers() });
  for (const note of r.notes ?? []) test.info().annotations.push({ type: 'contract-note', description: note });
  expect(r.ok, \`CONTRACT_MISMATCH \${method.toUpperCase()} \${path} (\${r.kind}): \${r.errors.join('; ')}\`).toBe(true);
  return body;
}

/** Functional check: the status is one of the expected documented ones ("404", "4XX"...). The body is checked in contract.spec.ts. */
export function expectStatus(res: APIResponse, documented: string[], method: string, path: string): void {
  const s = String(res.status());
  const ok = documented.some((c) => c === s || (/^\\dXX$/i.test(c) && c[0] === s[0]));
  expect(ok, \`CONTRACT_MISMATCH \${method.toUpperCase()} \${path}: expected documented rejection \${documented.join('/')}, got \${s}\`).toBe(true);
}

/** The request must be rejected with one of the documented statuses ("400", "422", "4XX"...), then match the contract. */
export async function expectRejected(res: APIResponse, documented: string[], method: string, path: string): Promise<unknown> {
  expectStatus(res, documented, method, path);
  return expectContract(res, method, path);
}

/* Collection checks (a reviewed "collection" mapping in the deps file). Same semantics in contract.py. */

/** The array a collection response holds ("" = the body itself). */
export function itemsOf(body: unknown, pointer: string): unknown[] {
  const v = pointer ? readPointer(body, pointer) : body;
  expect(Array.isArray(v), 'collection at "' + (pointer || '(body)') + '" is an array').toBe(true);
  return v as unknown[];
}
const idOf = (item: unknown, ptr: string) => String(readPointer(item, ptr));

/** The resource with this id is in the collection; returns it. */
export function expectContains(items: unknown[], idPtr: string, id: unknown, what = 'resource'): unknown {
  const found = items.find((i) => idOf(i, idPtr) === String(id));
  expect(found, what + ' ' + String(id) + ' is in the collection').toBeDefined();
  return found;
}

export function expectNotContains(items: unknown[], idPtr: string, id: unknown, what = 'resource'): void {
  expect(items.some((i) => idOf(i, idPtr) === String(id)), what + ' ' + String(id) + ' is not in the collection').toBe(false);
}

/** Fields compare by policy: exact, tolerance:<n>; ignore and schema are not compared here (schema: contract suite). */
export function expectFields(item: unknown, expected: unknown, policies: Record<string, string>): void {
  for (const [ptr, policy] of Object.entries(policies)) {
    if (policy === 'ignore' || policy === 'schema') continue;
    const want = readPointer(expected, ptr);
    if (want === undefined) continue;
    const got = readPointer(item, ptr);
    if (policy.startsWith('tolerance:')) {
      const t = Number(policy.slice('tolerance:'.length));
      expect(Math.abs(Number(got) - Number(want)), ptr + ' within ' + t + ' of ' + String(want) + ' (got ' + String(got) + ')').toBeLessThanOrEqual(t);
    } else expect(got, ptr + ' as sent').toEqual(want);
  }
}

/** Every element matches a filter: equals (the field is the value) or contains (the array field holds it). */
export function expectAllMatch(items: unknown[], ptr: string, match: 'equals' | 'contains', value: unknown): void {
  const bad = items.filter((i) => {
    const v = readPointer(i, ptr);
    return match === 'contains' ? !(Array.isArray(v) && v.map(String).includes(String(value))) : String(v) !== String(value);
  });
  expect(bad.length, bad.length + ' element(s) do not match ' + ptr + ' ' + match + ' ' + String(value)).toBe(0);
}

/** A filtered result holds only resources the unfiltered collection shows (a filter narrows, never adds). */
export function expectSubsetOf(items: unknown[], base: unknown[], idPtr: string, what: string): void {
  const known = new Set(base.map((i) => idOf(i, idPtr)));
  const extra = items.map((i) => idOf(i, idPtr)).filter((id) => !known.has(id));
  expect(extra, what + ' returns resources the unfiltered collection does not show').toEqual([]);
}

export function expectUniqueBy(items: unknown[], ptr: string): void {
  const seen = new Set<string>();
  const dups = items.map((i) => idOf(i, ptr)).filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
  expect(dups, 'duplicates by ' + ptr).toEqual([]);
}

/** Order by plain comparison (code points for strings, numeric for numbers): the API must document this order. */
export function expectSortedBy(items: unknown[], ptr: string, order: 'asc' | 'desc'): void {
  for (let i = 1; i < items.length; i++) {
    const a = readPointer(items[i - 1], ptr) as any;
    const b = readPointer(items[i], ptr) as any;
    const ok = order === 'asc' ? !(b < a) : !(b > a);
    expect(ok, ptr + ' ' + order + ' at position ' + i + ': ' + String(a) + ' then ' + String(b)).toBe(true);
  }
}

export function expectPageSize(items: unknown[], max: number): void {
  expect(items.length, 'page size').toBeLessThanOrEqual(max);
}

export function expectNoDuplicateAcrossPages(pages: unknown[][], idPtr: string): void {
  expectUniqueBy(pages.flat(), idPtr);
}

/** Leaf pointers of a value (objects and arrays walked). */
function leaves(v: unknown, prefix = ''): string[] {
  if (v && typeof v === 'object' && Object.keys(v).length) return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => leaves(x, prefix + '/' + k.replace(/~/g, '~0').replace(/\\//g, '~1')));
  return [prefix];
}

/**
 * Approved fixture (strategy B): every expected element is in the collection, each field compared by its policy
 * (the longest matching policy pointer, else the default): exact, tolerance:<n>, schema (present), ignore.
 * exhaustive: the collection holds exactly the expected elements.
 */
export function expectMatchesFixture(items: unknown[], f: { id: string; expected: unknown[]; policies?: Record<string, string>; default?: string; exhaustive?: boolean }): void {
  const policyOf = (leaf: string) => {
    const hit = Object.keys(f.policies ?? {}).filter((p) => leaf === p || leaf.startsWith(p + '/')).sort((a, b) => b.length - a.length)[0];
    return hit ? f.policies![hit] : f.default ?? 'exact';
  };
  for (const want of f.expected) {
    const id = readPointer(want, f.id);
    const got = expectContains(items, f.id, id, 'approved fixture element');
    for (const leaf of leaves(want)) {
      const policy = policyOf(leaf);
      const a = readPointer(got, leaf);
      const b = readPointer(want, leaf);
      const at = 'element ' + String(id) + ' ' + leaf;
      if (policy === 'ignore') continue;
      if (policy === 'schema') expect(a, at + ' is present').not.toBeUndefined();
      else if (policy.startsWith('tolerance:')) expect(Math.abs(Number(a) - Number(b)), at + ' within ' + policy.slice(10) + ' of ' + String(b) + ' (got ' + String(a) + ')').toBeLessThanOrEqual(Number(policy.slice(10)));
      else expect(a, at + ' as approved').toEqual(b);
    }
  }
  if (f.exhaustive) expect(items.length, 'the collection holds exactly the approved elements').toBe(f.expected.length);
}

/** Bounded polling for documented eventual consistency: returns the last value; never waits past timeoutMs. */
export async function poll<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number, intervalMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  let v = await fn();
  while (!done(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, intervalMs));
    v = await fn();
  }
  return v;
}

/** A copy of a payload without the fields at these JSON pointers (array elements by index). */
export function withoutFields<T>(payload: T, ptrs: string[]): T {
  const out = structuredClone(payload) as any;
  for (const ptr of ptrs) {
    const keys = ptr.split('/').slice(1).map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    let node = out;
    for (const k of keys.slice(0, -1)) node = node == null ? undefined : node[k];
    if (node && typeof node === 'object') delete node[keys[keys.length - 1]];
  }
  return out;
}

/** A copy of a payload with one field (JSON pointer through objects) set. */
export function withValue<T>(payload: T, ptr: string, value: unknown): T {
  const out = structuredClone(payload) as any;
  const keys = ptr.split('/').slice(1).map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = out;
  for (const k of keys.slice(0, -1)) node = node[k] ??= {};
  node[keys[keys.length - 1]] = value;
  return out;
}

/** Scenario values: "{name}" alone is replaced by the saved value itself, inside a longer string by its text. */
export function fillVars<T>(value: T, vars: Record<string, unknown>): T {
  const sub = (v: any): any => {
    if (typeof v === 'string') {
      const whole = v.match(/^\\{([A-Za-z_]\\w*)\\}$/);
      if (whole) return vars[whole[1]];
      return v.replace(/\\{([A-Za-z_]\\w*)\\}/g, (_: string, k: string) => String(vars[k]));
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  return sub(value);
}

export function readPointer(body: unknown, pointer: string): unknown {
  return pointer
    .split('/')
    .slice(1)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<any>((node, key) => (node == null ? undefined : node[key]), body);
}
`;
