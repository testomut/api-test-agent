import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenApiDoc } from '../spec/loader.js';
import type { Operation } from '../types.js';
import { resolvePointer } from '../spec/loader.js';
import { schemaAt } from '../generate/collection.js';

/**
 * Strategy B: approved fixtures. A fixture is data a human approved as the expected content of a collection
 * (e.g. reference data that tests must not create). The generator only reads approved fixtures; capture writes
 * candidates to a separate directory, and a candidate becomes approved only when a person moves it (Draft PR).
 *
 * fixtures/approved/<operationId>.json:
 * {
 *   "schemaVersion": 1,
 *   "operationId": "listCategories",
 *   "query": { "tag": "seed" },              request parameters of the read (documented query parameters)
 *   "items": "/data",                         JSON pointer to the array ("" = the body is the array)
 *   "id": "/id",                              element field that identifies an expected element
 *   "policies": { "/updatedAt": "ignore", "/price": "tolerance:0.01", "/slug": "schema" },
 *   "default": "exact",                       policy of every other field: exact | schema | ignore
 *   "exhaustive": false,                      true: the collection holds exactly these elements
 *   "page": { "style": "offset", "offsetParam": "offset", "limitParam": "limit", "size": 50, "maxPages": 20 },
 *   "expected": [ { "id": 1, "name": "Hand tools" } ]
 * }
 * Policies: exact (equal), tolerance:<n> (numbers within n), schema (present; its shape is the contract suite's job),
 * ignore (not compared).
 */

export interface Fixture {
  schemaVersion: 1;
  operationId: string;
  query?: Record<string, string | number | boolean>;
  items: string;
  id: string;
  policies?: Record<string, string>;
  default?: 'exact' | 'schema' | 'ignore';
  exhaustive?: boolean;
  page?: { style: 'offset'; offsetParam: string; limitParam: string; size?: number; maxPages?: number } | { style: 'page'; pageParam: string; sizeParam: string; firstPage?: number; size?: number; maxPages?: number };
  expected: unknown[];
  /** Capture metadata (candidates only; kept when a candidate is approved). */
  captured?: { at: string; from: string };
}

export interface LoadedFixture {
  file: string;
  fixture: Fixture;
  op: Operation;
}

const POLICY = /^(exact|schema|ignore|tolerance:\d+(\.\d+)?)$/;

export function validateFixture(doc: OpenApiDoc, ops: Operation[], f: Fixture): { op?: Operation; errors: string[] } {
  const errors: string[] = [];
  if (f?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  const op = ops.find((o) => o.operationId === f?.operationId);
  if (!op) return { errors: [...errors, `operation "${f?.operationId}" is not in the spec`] };
  if (op.method !== 'get') errors.push(`${op.key} is not a GET: fixtures describe data that is read, never written`);
  const ok = op.responses.find((r) => /^2\d\d$/.test(r.status));
  const schema = ok ? resolvePointer(doc, `/paths/${op.path.replace(/~/g, '~0').replace(/\//g, '~1')}/get/responses/${ok.status}/content/application~1json/schema`).node : undefined;
  if (!schema) errors.push(`${op.key} documents no JSON success schema`);
  else {
    const arr = schemaAt(doc, schema, f.items ?? '');
    if (!arr || !(arr.type === 'array' || arr.items)) errors.push(`"items" ${f.items} is not an array in the ${op.key} response`);
    else if (typeof f.id !== 'string' || !f.id.startsWith('/') || !schemaAt(doc, arr.items, f.id)) errors.push(`"id" ${f.id} is not a field of the ${op.key} elements`);
  }
  for (const [ptr, p] of Object.entries(f.policies ?? {})) if (!POLICY.test(p)) errors.push(`policy "${p}" of ${ptr} is not exact, schema, ignore or tolerance:<n>`);
  if (f.default !== undefined && !['exact', 'schema', 'ignore'].includes(f.default)) errors.push('"default" is exact, schema or ignore');
  for (const k of Object.keys(f.query ?? {})) if (!op.params.some((p) => p.in === 'query' && p.name === k)) errors.push(`query "${k}" is not a query parameter of ${op.key}`);
  const missing = op.params.filter((p) => p.required && p.in !== 'header' && !(p.in === 'query' && f.query && p.name in f.query) && p.knownValue === undefined);
  if (missing.length) errors.push(`${op.key} needs ${missing.map((p) => `${p.in} "${p.name}"`).join(', ')}`);
  if (f.page) {
    const names = f.page.style === 'offset' ? [f.page.offsetParam, f.page.limitParam] : f.page.style === 'page' ? [f.page.pageParam, f.page.sizeParam] : [];
    if (!names.length) errors.push('page style is offset or page');
    for (const n of names) if (!op.params.some((p) => p.in === 'query' && p.name === n)) errors.push(`page parameter "${n}" is not a query parameter of ${op.key}`);
  }
  if (!Array.isArray(f.expected) || !f.expected.length) errors.push('"expected" is a non-empty array');
  else {
    const ids = f.expected.map((e) => JSON.stringify(readPointer(e, f.id)));
    if (ids.some((i) => i === undefined)) errors.push(`every expected element has an "id" at ${f.id}`);
    if (new Set(ids).size !== ids.length) errors.push(`expected elements repeat an id at ${f.id}`);
  }
  return errors.length ? { errors } : { op, errors };
}

/** Approved fixtures of a directory (<dir>/*.json); an invalid one is reported, never used. */
export async function loadApproved(dir: string, doc: OpenApiDoc, ops: Operation[]): Promise<{ fixtures: LoadedFixture[]; errors: { file: string; operationId?: string; errors: string[] }[] }> {
  const fixtures: LoadedFixture[] = [];
  const errors: { file: string; operationId?: string; errors: string[] }[] = [];
  if (!existsSync(dir)) return { fixtures, errors };
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
    const file = join(dir, name);
    let f: Fixture;
    try {
      f = JSON.parse(await readFile(file, 'utf8'));
    } catch (e) {
      errors.push({ file, errors: [`not JSON: ${(e as Error).message}`] });
      continue;
    }
    const v = validateFixture(doc, ops, f);
    if (v.op && fixtures.some((x) => x.op === v.op)) errors.push({ file, operationId: f.operationId, errors: [`a second fixture for ${v.op.key}`] });
    else if (v.op) fixtures.push({ file, fixture: f, op: v.op });
    else errors.push({ file, operationId: f?.operationId, errors: v.errors });
  }
  return { fixtures, errors };
}

export function readPointer(body: unknown, pointer: string): unknown {
  return pointer
    .split('/')
    .slice(1)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<any>((node, key) => (node == null ? undefined : node[key]), body);
}

/** Leaf pointers of a value (objects and arrays walked; scalars and empty containers are leaves). */
export function leafPointers(v: unknown, prefix = ''): string[] {
  if (v && typeof v === 'object' && Object.keys(v).length) {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => leafPointers(x, `${prefix}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`));
  }
  return [prefix];
}

/** Policy of one leaf: the longest policy pointer that is the leaf or one of its parents, else the default. */
export function policyOf(f: Pick<Fixture, 'policies' | 'default'>, leaf: string): string {
  const hit = Object.keys(f.policies ?? {})
    .filter((p) => leaf === p || leaf.startsWith(p + '/'))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? f.policies![hit] : f.default ?? 'exact';
}

export interface FixtureDiff {
  added: string[];
  removed: string[];
  changed: { id: string; pointer: string; before: unknown; after: unknown }[];
}

/** Differences between an approved fixture and a candidate that its policies would fail on (ignored fields skipped). */
export function diffFixtures(approved: Fixture, candidate: Fixture): FixtureDiff {
  const key = (e: unknown) => JSON.stringify(readPointer(e, approved.id));
  const before = new Map(approved.expected.map((e) => [key(e), e]));
  const after = new Map(candidate.expected.map((e) => [key(e), e]));
  const out: FixtureDiff = { added: [...after.keys()].filter((k) => !before.has(k)), removed: [...before.keys()].filter((k) => !after.has(k)), changed: [] };
  for (const [id, b] of before) {
    const a = after.get(id);
    if (a === undefined) continue;
    for (const leaf of [...new Set([...leafPointers(b), ...leafPointers(a)])]) {
      const policy = policyOf(approved, leaf);
      const x = readPointer(b, leaf);
      const y = readPointer(a, leaf);
      if (policy === 'ignore') continue;
      if (policy === 'schema' ? (x === undefined) !== (y === undefined) : policy.startsWith('tolerance:') ? !(Math.abs(Number(x) - Number(y)) <= Number(policy.slice(10))) : JSON.stringify(x) !== JSON.stringify(y)) {
        out.changed.push({ id, pointer: leaf, before: x, after: y });
      }
    }
  }
  return out;
}

export const fixtureDiffIsEmpty = (d: FixtureDiff) => !d.added.length && !d.removed.length && !d.changed.length;
