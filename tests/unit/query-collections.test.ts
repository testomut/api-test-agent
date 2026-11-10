import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { generate } from '../../src/generate/generate.js';
import { paramCasesDetailed } from '../../src/generate/param-cases.js';
import { paramProbes } from '../../src/generate/probes.js';
import { queryVariantsDetailed } from '../../src/generate/templates.js';
import { resolveCollection } from '../../src/generate/collection.js';
import { planCollectionTests } from '../../src/generate/collection-tests.js';
import { parseCaseId } from '../../src/cases/ids.js';
import { validateRegistry } from '../../src/cases/validate.js';
import { normalizeSpec } from '../../src/change/normalize.js';
import { cleanupProblems } from '../../src/report/quality-gates.js';

/** Query parameters (confirmed cases and exploratory probes) and the GET collection additions (search, total, sort-reverse). */

const demo = await loadSpec('demo-api/openapi.yaml');
const ops = buildCatalog(demo.doc);
const deps = JSON.parse(await readFile('demo-api/deps.json', 'utf8'));
const op = (k: string) => ops.find((o) => o.key === k)!;
const kinds = (probes: { param: string; kind: string }[], param: string) => probes.filter((p) => p.param === param).map((p) => p.kind);

async function gen(lang: 'typescript' | 'python') {
  const dir = await mkdtemp(join(tmpdir(), 'ata-qc-'));
  const r = await generate(demo, ops, { outDir: dir, version: 'test', lang, deps });
  return { dir, r, read: (f: string) => readFile(join(dir, f), 'utf8') };
}

describe('confirmed query-parameter cases', () => {
  const list = paramCasesDetailed(demo.doc, op('GET /items'), { allowPath: true, allowOthers: true });

  it('an integer parameter also gets a decimal inside its bounds (only the type is broken)', () => {
    const d = list.cases.find((c) => c.source === 'query.limit.type.decimal')!;
    expect(d.request?.params).toEqual({ limit: '20.5' });
    expect(d.target).toEqual({ in: 'query', field: 'limit', rule: 'type', variant: 'decimal' });
    expect(parseCaseId(`ata:op_AAAAAAAAAAAA:contract:negative:request.query#/limit/decimal:type`).ok).toBe(true);
  });

  it('every query case records the value that must go over HTTP (null: not sent)', () => {
    const q = list.cases.filter((c) => c.target?.in === 'query');
    expect(q.every((c) => c.sent !== undefined)).toBe(true);
    expect(list.cases.find((c) => c.source === 'query.limit.maximum')!.sent).toEqual({ name: 'limit', value: '101' });
    const missing = paramCasesDetailed(demo.doc, op('GET /items/search'), { allowPath: true, allowOthers: true }).cases.find((c) => c.source === 'query.q.required')!;
    expect(missing.sent).toEqual({ name: 'q', value: null });
  });

  it('a decimal that would also break multipleOf is a gap, not a case', () => {
    const o = structuredClone(op('GET /items'));
    (o.params.find((p) => p.name === 'limit')!.schema as any).multipleOf = 5;
    const r = paramCasesDetailed(demo.doc, o, { allowPath: true, allowOthers: true });
    expect(r.cases.some((c) => c.source === 'query.limit.type.decimal')).toBe(false);
    expect(r.gaps).toContainEqual(expect.objectContaining({ code: 'CANNOT_ISOLATE_RULE', rule: 'type', location: 'request.query#/limit' }));
  });

  it('accepted values over the limits are reported, never dropped silently', () => {
    const o = structuredClone(op('GET /items'));
    (o.params.find((p) => p.name === 'sort')!.schema as any).enum = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const v = queryVariantsDetailed(o);
    expect(v.dropped.filter((x) => x.name === 'sort').map((x) => x.value)).toEqual(['f', 'g']);
  });
});

describe('exploratory probes (recorded, never asserted)', () => {
  const confirmed = paramCasesDetailed(demo.doc, op('GET /items'), { allowPath: true, allowOthers: true }).cases;
  const r = paramProbes(op('GET /items'), confirmed);

  it('no probe repeats a confirmed rule or a value the spec makes valid', () => {
    expect(kinds(r.probes, 'limit')).toEqual(['empty']); // text / decimal / zero / negative / large: confirmed cases
    expect(kinds(r.probes, 'offset')).toEqual(['empty', 'large']); // zero is valid (minimum 0), negative is the minimum case
    expect(kinds(r.probes, 'tag')).toEqual(['special']); // empty: the minLength case; long: the maxLength case
    expect(kinds(r.probes, 'sort')).toEqual(['empty', 'case']);
  });

  it('without documented rejections everything is a probe, never a confirmed failure', () => {
    const p = paramProbes(op('GET /items'), []);
    // zero and -1 break minimum 1, but no rejection is documented: the answer is unspecified, so they are probes.
    expect(kinds(p.probes, 'limit')).toEqual(['empty', 'text', 'decimal', 'zero', 'negative', 'large']);
    for (const x of p.probes) expect(parseCaseId(`ata:op_AAAAAAAAAAAA:contract:negative:${x.location}:probe`).ok, x.location).toBe(true);
  });

  it('a write operation is never probed: a gap says why', () => {
    const o = structuredClone(op('GET /items'));
    o.method = 'post';
    const p = paramProbes(o, []);
    expect(p.probes).toEqual([]);
    expect(p.gaps).toEqual([expect.objectContaining({ code: 'UNSAFE_LIVE_CHECK', rule: 'probe' })]);
  });

  it('generated probes never assert the API: they check what was sent and record the answer', async () => {
    const ts = await (await gen('typescript')).read('items/get/contract.spec.ts');
    const block = ts.slice(ts.indexOf('for (const p of probes)'));
    expect(block).toContain('expectSentQuery(res, p.param, p.value);');
    expect(block).toContain('await recordProbe(res,');
    expect(block.slice(0, block.indexOf('  }\n'))).not.toMatch(/expectRejected|expectStatus|expectContract/);
  });
});

describe('GET collections: search, total, sort-reverse, several mappings', () => {
  const createSchema = { $ref: '#/components/schemas/ItemInput' };
  const [items, search] = deps.scenarios[0].collections;

  it('validates the new mapping parts against the spec', () => {
    expect(resolveCollection(demo.doc, ops, search).errors).toEqual([]);
    const bad = { ...search, total: '/items', filters: [{ param: 'q', field: '/price', match: 'search' }] };
    const errors = resolveCollection(demo.doc, ops, bad).errors.join('\n');
    expect(errors).toContain('"total" /items is not an integer field');
    expect(errors).toContain('search filter field "/price" is not a string');
  });

  it('plans the total and the reverse-order checks on controlled data', () => {
    const c = resolveCollection(demo.doc, ops, items).collection!;
    const p = planCollectionTests(demo.doc, c, { canCreate: true, createSchema, canUpdate: true, updatePayload: { name: 'x' }, canDelete: true });
    expect(p.tests.filter((t) => t.kind === 'sort-reverse').map((t) => `${t.sort!.value}/${t.sortDesc!.value}:${t.mode}`)).toEqual(['name/-name:controlled', 'price/-price:controlled']);
    expect(p.tests.find((t) => t.kind === 'total')?.mode).toBe('controlled');
  });

  it('a search list with a required parameter: isolated by the search itself; no lifecycle once the update changes the name', () => {
    const c = resolveCollection(demo.doc, ops, search).collection!;
    const p = planCollectionTests(demo.doc, c, { canCreate: true, createSchema, canUpdate: true, updatePayload: { name: 'renamed' }, canDelete: true });
    expect(p.iso).toEqual({ param: 'q', field: '/name', match: 'search' });
    expect(p.lifecycle).toBe(false);
    expect(p.gaps).toContainEqual(expect.objectContaining({ code: 'CANNOT_ISOLATE_RULE', location: 'lifecycle' }));
  });

  it('TypeScript and Python generate the same cases; the registry is valid; no Python test shadows its fixture', async () => {
    const ts = await gen('typescript');
    const py = await gen('python');
    const active = async (g: typeof ts) => Object.entries<any>(JSON.parse(await g.read('_support/cases.json')).cases).filter(([, c]) => c.status !== 'retired').map(([id]) => id).sort();
    const [a, b] = [await active(ts), await active(py)];
    expect(b).toEqual(a);
    for (const rule of [':probe', '/decimal:type', ':sort-reverse', ':total', 'request.query#/q:filter']) expect(a.some((id) => id.includes(rule)), rule).toBe(true);
    const reg = validateRegistry(await ts.read('_support/cases.json'), normalizeSpec(await readFile('demo-api/openapi.yaml', 'utf8'), 'demo'));
    expect(reg.errors).toEqual([]);
    const search = await ts.read('items-search/get/functional.spec.ts');
    expect(search).toContain('.toUpperCase()'); // the query in upper case, the data in lower case
    for (const f of ['items/get/test_functional.py', 'items_search/get/test_functional.py']) expect(cleanupProblems((await py.read(f)).replace(/\r\n/g, '\n'), 'python'), f).toEqual([]);
  });
});
