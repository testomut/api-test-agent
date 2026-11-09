import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { generate } from '../../src/generate/generate.js';
import { collectionGaps, resolveCollection, type CollectionConfig } from '../../src/generate/collection.js';
import { planCollectionTests } from '../../src/generate/collection-tests.js';
import { parseCaseId } from '../../src/cases/ids.js';
import { diffFixtures, loadApproved, policyOf, validateFixture, type Fixture } from '../../src/fixtures/fixtures.js';
import { validateRegistry } from '../../src/cases/validate.js';
import { normalizeSpec } from '../../src/change/normalize.js';

/** Collection testing (docs/SUPPORT_MATRIX.md, "Collections"): reviewed mapping, strategies, fixtures, IDs. */

const demo = await loadSpec('demo-api/openapi.yaml');
const ops = buildCatalog(demo.doc);
const deps = JSON.parse(await readFile('demo-api/deps.json', 'utf8'));
const cfg: CollectionConfig = deps.scenarios[0].collection;
const approved: Fixture = JSON.parse(await readFile('demo-api/fixtures/approved/listItems.json', 'utf8'));
const createSchema = { $ref: '#/components/schemas/ItemInput' };

async function gen(lang: 'typescript' | 'python', withFixtures = true) {
  const dir = await mkdtemp(join(tmpdir(), 'ata-coll-'));
  const fx = withFixtures ? await loadApproved('demo-api/fixtures/approved', demo.doc, ops) : undefined;
  const r = await generate(demo, ops, { outDir: dir, version: 'test', lang, deps, ...(fx ? { fixtures: fx.fixtures, fixtureErrors: fx.errors } : {}) });
  return { dir, r, read: (f: string) => readFile(join(dir, f), 'utf8') };
}
const idsIn = (text: string) => [...text.matchAll(/(?:description: |caseId: )'([^']+)'|api_case_id\("([^"]+)"\)/g)].map((m) => m[1] ?? m[2]).filter((x) => x !== 'c.caseId');

describe('reviewed collection mapping', () => {
  it('resolves the demo mapping against the spec', () => {
    const r = resolveCollection(demo.doc, ops, cfg);
    expect(r.errors).toEqual([]);
    expect(r.collection?.op.key).toBe('GET /items');
    expect(r.collection?.maxPages).toBe(20);
  });

  it('rejects every part that does not match the spec, never guessing', () => {
    const bad = {
      ...cfg,
      items: '/total',
      id: '/nope',
      fields: { '/name': 'roughly' },
      filters: [{ param: 'colour', field: '/tags', match: 'like' as any }],
      sorts: [{ param: 'sort', value: 'weight', field: '/price', order: 'up' as any }],
      page: { style: 'offset' as const, offsetParam: 'skip', limitParam: 'limit' },
      consistency: { pollTimeoutMs: 120_000, pollIntervalMs: 10 },
    };
    const errors = resolveCollection(demo.doc, ops, bad).errors.join('\n');
    for (const part of ['"/total" is not an array', 'policy "roughly"', 'filter parameter "colour"', 'match "like"', 'sort value "weight"', 'sort order', 'offset parameter "skip"', 'consistency']) expect(errors).toContain(part);
    expect(resolveCollection(demo.doc, ops, { ...cfg, operationId: 'createItem' }).errors.join()).toContain('not a GET');
  });

  it('flags only real collections without a mapping (a single resource with an array field is not one)', () => {
    const op = (k: string) => ops.find((o) => o.key === k)!;
    expect(collectionGaps(demo.doc, op('GET /items'), false).map((g) => g.code)).toEqual(['UNCONFIRMED_BUSINESS_RULE']);
    expect(collectionGaps(demo.doc, op('GET /items/{itemId}'), false)).toEqual([]);
    expect(collectionGaps(demo.doc, op('GET /items'), true)).toEqual([]);
  });
});

describe('strategy selection', () => {
  const c = resolveCollection(demo.doc, ops, cfg).collection!;

  it('create & verify: every check on records the test creates, isolated by a filter', () => {
    const p = planCollectionTests(demo.doc, c, { canCreate: true, createSchema, canUpdate: true, updatePayload: { name: 'x', price: 1 }, canDelete: true });
    expect(p.iso?.param).toBe('tag');
    expect(p.tests.map((t) => `${t.kind}:${t.mode}`)).toEqual(['listed:controlled', 'filter:controlled', 'sort:controlled', 'sort:controlled', 'sort:controlled', 'sort:controlled', 'pagination:controlled', 'unique:controlled']);
    expect(p.tests.find((t) => t.sort?.value === 'price')?.sortValues).toEqual([2, 0, 1]); // distinct, created out of order
    expect(p.lifecycle && p.lifecycleIso).toBe(true);
    expect(p.pageSize).toBe(2);
  });

  it('read-only without a create: the same properties on existing data, reasons as gaps', () => {
    const p = planCollectionTests(demo.doc, c, { canCreate: false, canUpdate: false, canDelete: false });
    expect(p.tests.every((t) => t.mode === 'read-only')).toBe(true);
    expect(p.tests.some((t) => t.kind === 'listed')).toBe(false);
    expect(p.gaps.map((g) => g.code)).toEqual(['MISSING_CLEANUP', 'UNCONFIRMED_BUSINESS_RULE']);
  });

  it('an update that changes the isolating field makes the lifecycle read the unfiltered list', () => {
    const p = planCollectionTests(demo.doc, c, { canCreate: true, createSchema, canUpdate: true, updatePayload: { tags: ['other'] }, canDelete: true });
    expect(p.lifecycleIso).toBe(false);
  });
});

describe('generated collection tests', () => {
  it('TypeScript and Python have the same collection cases, each a valid v3 case ID', async () => {
    const ts = await gen('typescript');
    const py = await gen('python');
    const tsIds = idsIn(await ts.read('items/get/functional.spec.ts')).concat(idsIn(await ts.read('items/get/scenarios.spec.ts'))).sort();
    const pyIds = idsIn(await py.read('items/get/test_functional.py')).concat(idsIn(await py.read('items/get/test_scenarios.py'))).sort();
    expect(pyIds).toEqual(tsIds);
    expect(new Set(tsIds).size).toBe(tsIds.length);
    const rules = tsIds.map((id) => (parseCaseId(id) as any).parts.rule);
    for (const r of ['collection-contains', 'filter', 'sort', 'pagination', 'unique', 'fixture', 'crud']) expect(rules).toContain(r);
    for (const id of tsIds) expect(parseCaseId(id).ok, id).toBe(true);
    const reg = validateRegistry(await ts.read('_support/cases.json'), normalizeSpec(await readFile('demo-api/openapi.yaml', 'utf8'), 'demo-api/openapi.yaml'));
    expect(reg.errors).toEqual([]);
  });

  it('records the strategy per list operation in coverage', async () => {
    const { r } = await gen('typescript');
    const c = r.coverage.find((x) => x.operation === 'GET /items')!;
    expect(c.collection?.strategy).toBe('create-verify');
    expect((c.collection as any).strategies).toEqual(['create-verify', 'fixtures']);
    expect(c.collection?.tests.filter((t) => t.kind === 'fixture')).toHaveLength(1);
  });

  it('controlled tests clean up in finally and poll only within the documented bound', async () => {
    const text = await (await gen('typescript', false)).read('items/get/functional.spec.ts');
    expect(text).toContain('for (const id of ids) await resource.remove(api, id);');
    expect(text).toContain('const POLL = {"timeoutMs":0,"intervalMs":100};');
    expect(text).toContain('const MAX_PAGES = 20;');
  });
});

describe('approved fixtures (strategy B)', () => {

  it('the demo fixture is valid; a broken one is reported, never used', () => {
    expect(validateFixture(demo.doc, ops, approved).errors).toEqual([]);
    const errors = validateFixture(demo.doc, ops, { ...approved, operationId: 'createItem' }).errors.join();
    expect(errors).toContain('not a GET');
    const dup = validateFixture(demo.doc, ops, { ...approved, expected: [approved.expected[0], approved.expected[0]], query: { colour: 'red' } }).errors.join('\n');
    expect(dup).toContain('repeat an id');
    expect(dup).toContain('query "colour"');
  });

  it('policies: the longest matching pointer wins, else the default', () => {
    expect(policyOf({ policies: { '/a': 'ignore', '/a/b': 'exact' }, default: 'schema' }, '/a/b/c')).toBe('exact');
    expect(policyOf({ policies: { '/a': 'ignore' }, default: 'schema' }, '/a/x')).toBe('ignore');
    expect(policyOf({ policies: {}, default: 'schema' }, '/z')).toBe('schema');
  });

  it('a candidate is compared under the approved policies (ignored and tolerated differences are not changes)', () => {
    const candidate = structuredClone(approved);
    (candidate.expected[0] as any).createdAt = '2030-01-01T00:00:00Z'; // ignore
    (candidate.expected[0] as any).price += 0.0005; // within tolerance:0.001
    expect(diffFixtures(approved, candidate)).toEqual({ added: [], removed: [], changed: [] });
    (candidate.expected[1] as any).name = 'Renamed';
    candidate.expected.push({ id: 'new' });
    const d = diffFixtures(approved, candidate);
    expect(d.added).toEqual(['"new"']);
    expect(d.changed).toEqual([{ id: JSON.stringify((approved.expected[1] as any).id), pointer: '/name', before: 'Catalog screwdriver', after: 'Renamed' }]);
  });
});
