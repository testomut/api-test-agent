import { describe, expect, it } from 'vitest';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { ContractValidator } from '../../src/contract/validator.js';
import { sampleFromSchema } from '../../src/generate/sample.js';
import { findChains } from '../../src/generate/graph.js';
import { parseJunit } from '../../src/audit/schemathesis.js';
import { redact, resolveAuth } from '../../src/audit/auth.js';

const demo = await loadSpec('demo-api/openapi.yaml');
const ops = buildCatalog(demo.doc);
const op = (key: string) => ops.find((o) => o.key === key)!;

describe('catalog', () => {
  it('lists every operation with path-level params merged in', () => {
    expect(ops).toHaveLength(11);
    expect(op('GET /items/{itemId}').params.map((p) => p.name)).toEqual(['itemId']);
  });

  it('reports deterministic testability issues instead of guessing', () => {
    const report = op('GET /reports/{reportId}').testabilityIssues.join(' ');
    expect(report).toMatch(/no schema/);
    expect(report).toMatch(/"reportId" has no example/);
    expect(op('GET /health').testabilityIssues).toEqual([]);
  });

  it('uses spec-provided values (default) for optional params', () => {
    expect(op('GET /items').params[0].knownValue).toBe(20);
  });
});

describe('ContractValidator', () => {
  const v = new ContractValidator(demo.doc);
  const item = { id: '4b3f0e8e-8a4c-4a7e-9d43-5bb1c2b1a111', name: 'x', price: 1, tags: [], createdAt: '2030-01-01T00:00:00Z' };

  it('accepts a conforming body', () => {
    expect(v.validateResponse({ method: 'get', path: '/items/{itemId}', status: 200, contentType: 'application/json', body: item }).ok).toBe(true);
  });

  it('flags schema violations with a field path', () => {
    const r = v.validateResponse({ method: 'get', path: '/stats', status: 200, contentType: 'application/json', body: { total: '3', totalValue: 0 } });
    expect(r).toMatchObject({ ok: false, kind: 'schema' });
    expect(r.errors[0]).toContain('/total');
  });

  it('flags undocumented status codes and content types', () => {
    expect(v.validateResponse({ method: 'get', path: '/health', status: 500, contentType: 'application/json', body: {} }).kind).toBe('undocumented-status');
    expect(v.validateResponse({ method: 'get', path: '/health', status: 200, contentType: 'text/html', body: '' }).kind).toBe('content-type');
  });

  it('follows $ref responses (components/responses)', () => {
    expect(v.validateResponse({ method: 'get', path: '/items/{itemId}', status: 404, contentType: 'application/json', body: {} }).ok).toBe(false);
    expect(v.validateResponse({ method: 'get', path: '/items/{itemId}', status: 404, contentType: 'application/json', body: { message: 'x' } }).ok).toBe(true);
  });

  it('understands OpenAPI 3.0 nullable', () => {
    const doc = {
      openapi: '3.0.3',
      paths: { '/x': { get: { responses: { '200': { description: '', content: { 'application/json': { schema: { type: 'object', properties: { a: { type: 'string', nullable: true } } } } } } } } } },
    };
    expect(new ContractValidator(doc).validateResponse({ method: 'get', path: '/x', status: 200, contentType: 'application/json', body: { a: null } }).ok).toBe(true);
  });
});

describe('sampleFromSchema', () => {
  it('builds payloads from examples and records where each value came from', () => {
    const r = sampleFromSchema(demo.doc, { $ref: '#/components/schemas/ItemInput' });
    expect(r.ok && r.value).toEqual({ name: 'Mechanical keyboard', price: 89.9, tags: ['hardware'] });
    expect(r.ok && r.sources.join()).toContain('example');
  });

  it('refuses a pattern it cannot satisfy rather than inventing a value', () => {
    const r = sampleFromSchema({}, { type: 'object', required: ['code'], properties: { code: { type: 'string', pattern: '^[A-Z]{3}-\\d+$' } } });
    expect(r.ok).toBe(false);
  });

  it('respects numeric and length bounds', () => {
    const r = sampleFromSchema({}, { type: 'object', required: ['n', 's'], properties: { n: { type: 'integer', minimum: 5 }, s: { type: 'string', minLength: 12 } } });
    expect(r.ok && (r.value as any).n).toBe(5);
    expect(r.ok && (r.value as any).s.length).toBeGreaterThanOrEqual(12);
  });
});

describe('dependency graph', () => {
  it('builds a confirmed CRUD chain from OpenAPI links', () => {
    const { chains } = findChains(demo.doc, ops);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({ idPointer: '/id', param: 'itemId' });
    expect([chains[0].read?.operationId, chains[0].update?.operationId, chains[0].delete?.operationId]).toEqual(['getItem', 'updateItem', 'deleteItem']);
  });

  it('treats path similarity without links as an unconfirmed candidate with a question', () => {
    const doc = structuredClone(demo.doc);
    delete doc.paths['/items'].post.responses['201'].links;
    const { chains, candidates } = findChains(doc, buildCatalog(doc));
    expect(chains).toHaveLength(0);
    expect(candidates[0].question).toMatch(/Is the path parameter "itemId"/);
  });

  it('accepts human-confirmed dependencies from a deps file', () => {
    const doc = structuredClone(demo.doc);
    delete doc.paths['/items'].post.responses['201'].links;
    const { chains } = findChains(doc, buildCatalog(doc), { scenarios: [{ create: 'createItem', idFrom: '/id', param: 'itemId', delete: 'deleteItem' }] });
    expect(chains[0].source).toMatch(/deps file/);
  });
});

describe('safety helpers', () => {
  it('redacts secrets from env and auth-looking headers', () => {
    const env = { API_TOKEN: 'super-secret-token' };
    expect(redact('curl -H "Authorization: Bearer super-secret-token"', env)).not.toContain('super-secret-token');
    expect(redact('x-api-key: abc123', {})).toBe('x-api-key: ***');
  });

  it('blocks operations whose credentials are missing', () => {
    const r = resolveAuth(demo.doc, op('POST /admin/reset').security, {});
    expect(r).toMatchObject({ ok: false });
    expect(resolveAuth(demo.doc, op('POST /admin/reset').security, { API_TOKEN: 't' }).ok).toBe(true);
  });

  it('parses Schemathesis JUnit output', () => {
    const xml = `<testsuite><testcase name="GET /a" time="1" /><testcase name="GET /b"><failure type="failure" message="ST108">- ST108 &quot;0&quot; is not of type</failure></testcase></testsuite>`;
    const m = parseJunit(xml);
    expect(m.get('GET /a')?.failure).toBeUndefined();
    expect(m.get('GET /b')?.failure).toContain('"0"');
  });
});

import { operationFolder } from '../../src/generate/templates.js';
import { bodyCases, documentedRejections } from '../../src/generate/negative.js';
import { paramCasesDetailed } from '../../src/generate/param-cases.js';

describe('test layout', () => {
  it('puts each operation in <resource>/<method>[-by-id]', () => {
    expect(operationFolder(op('GET /items'))).toEqual({ resource: 'items', action: 'get' });
    expect(operationFolder(op('POST /items'))).toEqual({ resource: 'items', action: 'post' });
    expect(operationFolder(op('GET /items/{itemId}'))).toEqual({ resource: 'items', action: 'get-by-id' });
    expect(operationFolder(op('POST /admin/reset'))).toEqual({ resource: 'admin-reset', action: 'post' });
  });
});

describe('negative cases', () => {
  it('derives one broken rule per case from the body schema', () => {
    const base = { name: 'Mechanical keyboard', price: 89.9, tags: ['hardware'] };
    const cases = bodyCases(demo.doc, { $ref: '#/components/schemas/ItemInput' }, base, 'ItemInput');
    const titles = cases.map((c) => c.title);
    expect(titles).toContain('missing required field "name"');
    expect(titles).toContain('"price" below minimum 0');
    expect(titles).toContain('unknown field is rejected (additionalProperties: false)');
    expect(cases.find((c) => c.title.startsWith('missing required field "name"'))?.data).not.toHaveProperty('name');
  });

  it('derives query cases from parameter bounds', () => {
    const r = paramCasesDetailed(demo.doc, op('GET /items'), { allowPath: true, allowOthers: true });
    expect(r.cases.map((c) => c.request?.params)).toEqual([{ limit: 'not-a-number' }, { limit: 0 }, { limit: 101 }]);
  });

  it('breaks exclusive bounds, minItems and query minLength, one rule per case', () => {
    const schema = {
      type: 'object',
      properties: {
        qty: { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 10 },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
    };
    const body = bodyCases(demo.doc, schema, { qty: 5, tags: ['a'] }, 'Order');
    expect(body.find((c) => c.source === 'Order.qty.exclusiveMinimum')?.data).toEqual({ qty: 0, tags: ['a'] });
    expect(body.find((c) => c.source === 'Order.qty.exclusiveMaximum')?.data).toEqual({ qty: 10, tags: ['a'] });
    expect(body.find((c) => c.source === 'Order.tags.minItems')?.data).toEqual({ qty: 5, tags: [] });
    const search = {
      ...op('GET /items'),
      params: [
        { name: 'page', in: 'query', required: false, schema: { type: 'integer', exclusiveMinimum: 0 } },
        { name: 'q', in: 'query', required: false, schema: { type: 'string', minLength: 3 } },
      ],
    } as any;
    const q = paramCasesDetailed(demo.doc, search, { allowPath: true, allowOthers: true }).cases;
    expect(q.find((c) => c.source === 'query.page.exclusiveMinimum')?.request?.params).toEqual({ page: 0 });
    expect(q.find((c) => c.source === 'query.q.minLength')?.request?.params).toEqual({ q: 'xx' });
  });

  it('only uses rejections the spec documents', () => {
    expect(documentedRejections(op('GET /health'))).toEqual({ validation: [], notFound: false, unauthorized: false });
    expect(documentedRejections(op('POST /items')).validation).toEqual(['400']);
    expect(documentedRejections(op('POST /admin/reset')).unauthorized).toBe(true);
  });
});

import { mkdtemp, readFile as readFileP } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinP } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generate, findPython } from '../../src/generate/generate.js';
import { pyLit } from '../../src/generate/python.js';

describe('python output', () => {
  it('converts JSON values to Python literals', () => {
    expect(pyLit({ a: true, b: null, c: [1, 'x'] })).toBe('{\n    "a": True,\n    "b": None,\n    "c": [1, "x"],\n}');
  });

  it('generates a pytest suite in the same layout, with packages and shared fixtures', async () => {
    const dir = await mkdtemp(joinP(tmpdir(), 'ata-py-'));
    const r = await generate(demo, ops, { outDir: dir, version: 'test', lang: 'python' });
    for (const f of ['conftest.py', '__init__.py', '_support/contract.py', '_support/items_resource.py', 'items/post/test_functional.py', 'items/post/test_contract.py', 'items/get_by_id/test_functional.py', 'items/patch_by_id/test_scenarios.py', 'health/get/test_functional.py', 'items/get_by_id/__init__.py']) {
      expect(existsSync(joinP(dir, f)), f).toBe(true);
    }
    expect(existsSync(joinP(dir, 'health/get/test_scenarios.py'))).toBe(false); // no multi-request flow → no file
    expect(await readFileP(joinP(dir, 'items/get_by_id/test_functional.py'), 'utf8')).toMatch(/pytestmark = pytest\.mark\.functional[\s\S]*@pytest\.mark\.positive[\s\S]*@pytest\.mark\.negative/);
    expect(await readFileP(joinP(dir, 'conftest.py'), 'utf8')).toContain('config.addinivalue_line("markers"');
    expect(await readFileP(joinP(dir, 'conftest.py'), 'utf8')).toContain('def created_items(items):');
    const py = r.files.filter((f) => f.endsWith('.py'));
    const compiled = spawnSync(findPython(), ['-m', 'py_compile', ...py], { encoding: 'utf8' });
    if (compiled.error) return; // no python on this machine: syntax check skipped
    expect(compiled.status, compiled.stderr).toBe(0);
  });
});

describe('three-file suite layout', () => {
  const tsDir = async () => {
    const dir = await mkdtemp(joinP(tmpdir(), 'ata-3f-'));
    const r = await generate(demo, ops, { outDir: dir, version: 'test' });
    return { dir, r, read: (f: string) => readFileP(joinP(dir, f), 'utf8') };
  };

  it('writes functional / contract / scenarios files per operation, never positive/negative', async () => {
    const { dir, r } = await tsDir();
    for (const f of ['items/post/functional.spec.ts', 'items/post/contract.spec.ts', 'items/get/functional.spec.ts', 'items/patch-by-id/scenarios.spec.ts', 'items/delete-by-id/scenarios.spec.ts']) expect(existsSync(joinP(dir, f)), f).toBe(true);
    expect(r.files.some((f) => /(positive|negative)\.spec\.ts$/.test(f))).toBe(false);
    // No empty files: a plain read has no multi-request flow of its own.
    expect(existsSync(joinP(dir, 'items/get-by-id/scenarios.spec.ts'))).toBe(false);
    expect(r.scenarios.find((s) => s.name === 'items/patch-by-id/scenarios')).toMatchObject({ kind: 'scenario', status: 'NOT_RUN' });
  });

  it('create → read lives under the create operation, in TypeScript and Python', async () => {
    const { read } = await tsDir();
    expect(await read('items/post/scenarios.spec.ts')).toMatch(/the created resource can be retrieved by getItem', \{ tag: '@positive', annotation: \{ type: 'caseId', description: 'ata:scn_[A-Z2-7]{12}:scenario:positive:lifecycle:crud' \} \}[\s\S]*api\.items\.getItem\(id\)[\s\S]*resource\.remove\(api, id\)/);
    const dir = await mkdtemp(joinP(tmpdir(), 'ata-3f-py-'));
    await generate(demo, ops, { outDir: dir, version: 'test', lang: 'python' });
    const py = await readFileP(joinP(dir, 'items/post/test_scenarios.py'), 'utf8');
    expect(py).toContain('def test_created_resource_can_be_read(api, created_items):');
    expect(py).toMatch(/assert str\(read_pointer\(read\.json\(\), "\/id"\)\) == created_items/);
  });

  it('checks the update result only in scenarios (marked ASSUMPTION), not again in functional', async () => {
    const { read } = await tsDir();
    expect(await read('items/patch-by-id/functional.spec.ts')).not.toContain('getItem');
    expect(await read('items/patch-by-id/scenarios.spec.ts')).toContain('ASSUMPTION');
  });

  it('returns coverage per operation and writes nothing but tests into the tests folder', async () => {
    const { dir, r } = await tsDir();
    expect(existsSync(joinP(dir, 'coverage-gaps.json'))).toBe(false);
    // Only the registry, the snapshot metadata and the manifest are JSON in the tests folder.
    expect(r.files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\\/g, '/').split('/').pop()).sort()).toEqual(['cases.json', 'generation-manifest.json', 'openapi.snapshot.meta.json']);
    expect(r.coverage.find((c) => c.operation === 'POST /items')).toMatchObject({ counts: { scenario: 1 }, positiveBlocked: null });
    expect(r.coverage.find((c) => c.operation === 'POST /admin/reset')?.positiveBlocked).toMatch(/no confirmed precondition/);
  });

  it('adds GET cases only for values the schema enumerates', async () => {
    const { queryVariants } = await import('../../src/generate/templates.js');
    const list = {
      ...op('GET /items'),
      params: [
        { name: 'sort', in: 'query', required: false, schema: { type: 'string', enum: ['asc', 'desc'] } },
        { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
      ],
    } as any;
    expect(queryVariants(list)).toEqual([{ name: 'sort', value: 'asc' }, { name: 'sort', value: 'desc' }]);
    expect(queryVariants({ ...list, method: 'post' })).toEqual([]);
  });

  it('puts checks in the right suite and tags polarity', async () => {
    const { read } = await tsDir();
    const functional = await read('items/get-by-id/functional.spec.ts');
    expect(functional).toContain("{ tag: '@functional' }");
    expect(functional).toMatch(/returns the resource created in the precondition', \{ tag: '@positive', annotation: \{ type: 'caseId', description: 'ata:op_[A-Z2-7]{12}:functional:positive:operation:documented-success' \} \}/);
    expect(functional).toMatch(/documented 404[^\n]*\{ tag: '@negative', annotation: \{ type: 'caseId', description: 'ata:op_[A-Z2-7]{12}:functional:negative:request\.path#\/itemId:not-found' \} \}/);
    expect(functional).not.toContain('expectContract'); // the schema belongs to contract.spec.ts
    const contract = await read('items/post/contract.spec.ts');
    expect(contract).toContain('success response matches the documented contract');
    expect(contract).toMatch(/rejects invalid body[^\n]*\{ tag: '@negative', annotation: \{ type: 'caseId', description: c\.caseId \} \}/);
    const scenario = await read('items/patch-by-id/scenarios.spec.ts');
    expect(scenario).toContain('api.items.updateItem(id');
    expect(scenario).toContain('api.items.getItem(id)');
    expect(scenario).not.toContain('randomUUID');
  });

  it('removes generated positive/negative files of the old layout, keeps hand-written ones', async () => {
    const { writeFile } = await import('node:fs/promises');
    const dir = await mkdtemp(joinP(tmpdir(), 'ata-3f-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(joinP(dir, 'items/get'), { recursive: true });
    mkdirSync(joinP(dir, 'health/get'), { recursive: true });
    await writeFile(joinP(dir, 'items/get/positive.spec.ts'), '// GET /items · positive cases. Generated by api-test-agent 0.1.3.\n');
    await writeFile(joinP(dir, 'health/get/negative.spec.ts'), '// my own negative checks\n');
    const r = await generate(demo, ops, { outDir: dir, version: 'test' });
    expect(existsSync(joinP(dir, 'items/get/positive.spec.ts'))).toBe(false);
    expect(r.removed.map((f) => f.replace(/\\/g, '/'))).toEqual([expect.stringMatching(/items\/get\/positive\.spec\.ts$/)]);
    expect(existsSync(joinP(dir, 'health/get/negative.spec.ts'))).toBe(true);
  });
});

describe('python folder guard', () => {
  it('refuses a tests folder that would shadow a Python module', async () => {
    const dir = await mkdtemp(joinP(tmpdir(), 'ata-guard-'));
    await expect(generate(demo, ops, { outDir: joinP(dir, 'py'), version: 'test', lang: 'python' })).rejects.toThrow(/shadows the "py" module/);
  });
});

describe('real-world spec quirks', () => {
  it('matches documented media types that carry parameters (application/json; v=1.0)', () => {
    const doc = { openapi: '3.0.1', paths: { '/a': { get: { responses: { '200': { description: '', content: { 'application/json; v=1.0': { schema: { type: 'array' } } } } } } } } };
    expect(new ContractValidator(doc).validateResponse({ method: 'get', path: '/a', status: 200, contentType: 'application/json; charset=utf-8', body: [] }).ok).toBe(true);
  });

  it('reads OpenAPI 3.2 with the 3.1 rules and says so', async () => {
    const { writeFile } = await import('node:fs/promises');
    const dir = await mkdtemp(joinP(tmpdir(), 'ata-32-'));
    const file = joinP(dir, 'openapi.json');
    await writeFile(file, JSON.stringify({ openapi: '3.2.0', info: { title: 't', version: '1' }, paths: { '/a': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: ['string', 'null'] } } } } } } } } }));
    const s = await loadSpec(file);
    expect(s.doc.openapi).toBe('3.2.0');
    expect(s.validationErrors[0]).toMatch(/3\.1 rules/);
    expect(new ContractValidator(s.doc).validateResponse({ method: 'get', path: '/a', status: 200, contentType: 'application/json', body: null }).ok).toBe(true);
  });
});

import { expandTemplate, loginConfig } from '../../src/audit/login.js';
import { redact as redactAll } from '../../src/audit/auth.js';

describe('login auth', () => {
  it('parses API_LOGIN and fills ${VAR} with JSON-escaped values', () => {
    expect(loginConfig({ API_LOGIN: 'post /auth/login' })).toEqual({ method: 'POST', path: '/auth/login', bodyTemplate: '{}', pointer: '/access_token' });
    expect(expandTemplate('{"u":"${U}","p":"${P}"}', { U: 'demo', P: 'pa"ss' })).toBe('{"u":"demo","p":"pa\\"ss"}');
    expect(() => expandTemplate('{"u":"${MISSING}"}', {})).toThrow(/MISSING/);
  });

  it('redacts any secret-looking variable, including custom login passwords', () => {
    expect(redactAll('login with s3cret-value', { SHOP_USER_PASSWORD: 's3cret-value' })).toBe('login with ***');
  });
});

describe('positive tests need real data', () => {
  const docFor = (paths: any) => ({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths });
  const ok = { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } };

  it('does not build a positive test on an example id (an illustration, not a real record)', async () => {
    const d = docFor({ '/brands/{brandId}': { get: { operationId: 'getBrand', parameters: [{ name: 'brandId', in: 'path', required: true, example: '1', schema: { type: 'string' } }], responses: ok } } });
    const dir = await mkdtemp(joinP(tmpdir(), 'ata-ex-'));
    const r = await generate({ ...demo, doc: d } as any, buildCatalog(d), { outDir: dir, version: 'test' });
    expect(r.scenarios.find((s) => s.name === 'brands/get-by-id/functional')).toMatchObject({ status: 'BLOCKED' });
    expect(r.scenarios.find((s) => s.name === 'brands/get-by-id/functional')!.reason).toMatch(/spec example, not from a real record/);
  });

  it('keeps logout out of the shared-session suite', async () => {
    const d = docFor({ '/users/logout': { get: { operationId: 'logout', responses: ok } } });
    const dir = await mkdtemp(joinP(tmpdir(), 'ata-lo-'));
    const r = await generate({ ...demo, doc: d } as any, buildCatalog(d), { outDir: dir, version: 'test' });
    expect(r.scenarios.find((s) => s.name === 'users-logout/get/functional')!.reason).toMatch(/ends the session/);
  });
});

import { uniqueFields } from '../../src/generate/generate.js';

describe('unique values for operations that document 409', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', example: 'new brand' },
      slug: { type: 'string', pattern: '^[a-z0-9-]+$', example: 'new-brand' },
      code: { type: 'string', pattern: '^[A-Z]{3}$', example: 'ABC' },
      kind: { type: 'string', enum: ['a', 'b'] },
      email: { type: 'string', format: 'email' },
      short: { type: 'string', maxLength: 10 },
      count: { type: 'integer' },
    },
  };
  const payload = { name: 'new brand', slug: 'new-brand', code: 'ABC', kind: 'a', email: 'a@example.com', short: 'abc', count: 1 };
  const with409 = { ...op('POST /items'), responses: [...op('POST /items').responses, { status: '409' }] } as any;

  it('suffixes only plain string fields, keeps enum / format / non-matching pattern, carries maxLength', () => {
    expect(uniqueFields(demo, with409, schema, payload)).toEqual({ name: null, slug: null, short: 10 });
  });

  it('changes nothing when no conflict is documented', () => {
    expect(uniqueFields(demo, op('POST /items'), schema, payload)).toEqual({});
  });

  it('generated helpers send a fresh payload on every call and say why', async () => {
    const d = structuredClone(demo.doc) as any;
    d.paths['/items'].post.responses['409'] = { description: 'Item name already exists' };
    const dir = await mkdtemp(joinP(tmpdir(), 'ata-uq-'));
    await generate({ ...demo, doc: d } as any, buildCatalog(d), { outDir: dir, version: 'test' });
    const helper = await readFileP(joinP(dir, '_support/items.resource.ts'), 'utf8');
    expect(helper).toContain('POST /items documents 409 (conflict): name get a unique suffix');
    expect(helper).toContain('export const newCreatePayload = () => unique(createPayload, {"name":100});');
    expect(helper).toContain('data: unknown = newCreatePayload()');
    expect(await readFileP(joinP(dir, 'items/post/functional.spec.ts'), 'utf8')).toContain('{ data: resource.newCreatePayload() }');
    const scenario = await readFileP(joinP(dir, 'items/patch-by-id/scenarios.spec.ts'), 'utf8');
    expect(scenario).toMatch(/const payload = resource\.newUpdatePayload\(\);[\s\S]*toMatchObject\(payload\);/);

    const py = await mkdtemp(joinP(tmpdir(), 'ata-uq-py-'));
    await generate({ ...demo, doc: d } as any, buildCatalog(d), { outDir: py, version: 'test', lang: 'python' });
    const pyHelper = await readFileP(joinP(py, '_support/items_resource.py'), 'utf8');
    expect(pyHelper).toContain('UNIQUE_CREATE = {\n    "name": 100,\n}');
    expect(await readFileP(joinP(py, 'items/post/test_functional.py'), 'utf8')).toContain('json=items.new_create_payload()');
  });
});

import { cleanupSummary } from '../../src/generate/generate.js';
import { buildReport, toMarkdown } from '../../src/report/report.js';

describe('test data left on the target', () => {
  it('cleanup reports a record it could not remove (404 = already gone), in TypeScript and Python', async () => {
    const dir = await mkdtemp(joinP(tmpdir(), 'ata-cl-'));
    await generate(demo, ops, { outDir: dir, version: 'test' });
    expect(await readFileP(joinP(dir, '_support/items.resource.ts'), 'utf8')).toContain(
      "if (!res || (!res.ok() && res.status() !== 404)) reportCleanupFailure('DELETE /items/{itemId}', id, res ? res.status() : 'no response');",
    );
    expect(await readFileP(joinP(dir, '_support/contract-assert.ts'), 'utf8')).toContain('export function reportCleanupFailure(');
    const py = await mkdtemp(joinP(tmpdir(), 'ata-cl-py-'));
    await generate(demo, ops, { outDir: py, version: 'test', lang: 'python' });
    expect(await readFileP(joinP(py, '_support/items_resource.py'), 'utf8')).toContain('report_cleanup_failure("DELETE /items/{itemId}", resource_id,');
    expect(await readFileP(joinP(py, '_support/contract.py'), 'utf8')).toContain('def report_cleanup_failure(');
  });

  it('groups failures for the summary and lists every record in the report', () => {
    const left = [
      { operation: 'DELETE /brands/{brandId}', id: 'a', status: 403 },
      { operation: 'DELETE /brands/{brandId}', id: 'b', status: 403 },
      { operation: 'DELETE /categories/{categoryId}', id: 'c', status: 'no response' },
    ];
    expect(cleanupSummary(left)).toEqual(['DELETE /brands/{brandId} → 403: 2 record(s)', 'DELETE /categories/{categoryId} → no response: 1 record(s)']);
    const md = toMarkdown(
      buildReport({
        mode: 'generate',
        spec: { location: 'x', hash: 'h', version: '3.1.0', validationErrors: [] },
        target: { baseUrl: 'http://x' },
        lint: { errors: 0, warnings: 0, problems: [] },
        ops: [],
        findings: [],
        generated: { files: [], scenarios: [], cleanupFailures: left },
      } as any),
    );
    expect(md).toContain('## ⚠️ Test data left on the target');
    expect(md).toContain('| `DELETE /brands/{brandId}` | 403 | `a` |');
  });
});

describe('stale resource helpers', () => {
  it('removes generated helpers of chains no longer planned, keeps hand-written ones', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { mkdirSync } = await import('node:fs');
    const dir = await mkdtemp(joinP(tmpdir(), 'ata-sh-'));
    mkdirSync(joinP(dir, '_support'), { recursive: true });
    await writeFile(joinP(dir, '_support/brands.resource.ts'), '// Data helpers for storeBrand lifecycle. Generated by api-test-agent 0.1.3.\n');
    await writeFile(joinP(dir, '_support/mine.resource.ts'), '// my own helpers\n');
    const r = await generate(demo, ops, { outDir: dir, version: 'test' });
    expect(existsSync(joinP(dir, '_support/brands.resource.ts'))).toBe(false);
    expect(existsSync(joinP(dir, '_support/mine.resource.ts'))).toBe(true);
    expect(existsSync(joinP(dir, '_support/items.resource.ts'))).toBe(true);
    expect(r.removed.map((f) => f.replace(/\\/g, '/'))).toContainEqual(expect.stringMatching(/_support\/brands\.resource\.ts$/));

    const py = await mkdtemp(joinP(tmpdir(), 'ata-sh-py-'));
    mkdirSync(joinP(py, '_support'), { recursive: true });
    await writeFile(joinP(py, '_support/brands_resource.py'), '"""Data helpers for storeBrand lifecycle. Generated by api-test-agent 0.1.3.\n"""\n');
    await generate(demo, ops, { outDir: py, version: 'test', lang: 'python' });
    expect(existsSync(joinP(py, '_support/brands_resource.py'))).toBe(false);
    expect(existsSync(joinP(py, '_support/items_resource.py'))).toBe(true);
  });
});

describe('deps "fill": values from existing data', () => {
  const deps = (fill: Record<string, { from: string; pointer: string }>) => ({
    scenarios: [{ create: 'createItem', idFrom: '/id', param: 'itemId', read: 'getItem', update: 'updateItem', delete: 'deleteItem', fill }],
  });

  it('reads the value from a GET at run time, in TypeScript and Python, and never suffixes it', async () => {
    const d = structuredClone(demo.doc) as any;
    d.paths['/items'].post.responses['409'] = { description: 'name taken' };
    const spec = { ...demo, doc: d } as any;
    const dir = await mkdtemp(joinP(tmpdir(), 'ata-fill-'));
    await generate(spec, buildCatalog(d), { outDir: dir, version: 'test', deps: deps({ name: { from: 'getHealth', pointer: '/status' } }) });
    const helper = await readFileP(joinP(dir, '_support/items.resource.ts'), 'utf8');
    expect(helper).toContain('$.name: filled at run time from GET /health #/status');
    expect(helper).toContain('deps file "fill": name: taken from existing data at run time');
    expect(helper).toContain('export async function newCreatePayload(api: Apis)');
    expect(helper).toContain('const source0 = await api.health.getHealth();');
    expect(helper).toContain("payload['name'] = readPointer(await source0.json(), '/status');");
    expect(helper).toContain('unique(createPayload, {})'); // name is filled, not suffixed, despite the documented 409
    expect(helper).toContain('data ??= await newCreatePayload(api);');
    expect(await readFileP(joinP(dir, 'items/post/functional.spec.ts'), 'utf8')).toContain('{ data: await resource.newCreatePayload(api) }');

    const py = await mkdtemp(joinP(tmpdir(), 'ata-fill-py-'));
    await generate(spec, buildCatalog(d), { outDir: py, version: 'test', lang: 'python', deps: deps({ name: { from: 'getHealth', pointer: '/status' } }) });
    const pyHelper = await readFileP(joinP(py, '_support/items_resource.py'), 'utf8');
    expect(pyHelper).toContain('    def new_create_payload(self):');
    expect(pyHelper).toContain('source = self.api.get("health")');
    expect(pyHelper).toContain('payload["name"] = read_pointer(source.json(), "/status")');
  });

  it('blocks the chain when the source is not a safe call or not in the spec', async () => {
    const run = async (fill: Record<string, { from: string; pointer: string }>) => {
      const dir = await mkdtemp(joinP(tmpdir(), 'ata-fill-'));
      const r = await generate(demo, ops, { outDir: dir, version: 'test', deps: deps(fill) });
      return r.scenarios.find((s) => s.name === 'items/post/functional')!.reason;
    };
    expect(await run({ name: { from: 'resetInventory', pointer: '/x' } })).toMatch(/fill "name": POST \/admin\/reset is not a GET/);
    expect(await run({ name: { from: 'noSuchOp', pointer: '/x' } })).toMatch(/fill "name": operation "noSuchOp" is not in the spec/);
    expect(await run({ name: { from: 'getItem', pointer: '/name' } })).toMatch(/fill "name": GET \/items\/\{itemId\} needs path "itemId"/);
    expect(await run({ name: { from: 'getHealth', pointer: 'status' } })).toMatch(/pointer must be a JSON pointer/);
  });
});

describe('create helper never leaves a record behind', () => {
  it('removes what it created when a check fails (e.g. an undocumented 2xx), TypeScript and Python', async () => {
    const dir = await mkdtemp(joinP(tmpdir(), 'ata-cr-'));
    await generate(demo, ops, { outDir: dir, version: 'test' });
    expect(await readFileP(joinP(dir, '_support/items.resource.ts'), 'utf8')).toMatch(/  try \{\n    expect\(res\.status\(\)[\s\S]*return \{ id, body \};\n  \} catch \(error\) \{\n[^\n]*\n    await removeIfCreated\(api, res\);\n    throw error;/);
    const py = await mkdtemp(joinP(tmpdir(), 'ata-cr-py-'));
    await generate(demo, ops, { outDir: py, version: 'test', lang: 'python' });
    expect(await readFileP(joinP(py, '_support/items_resource.py'), 'utf8')).toMatch(/        except AssertionError:\n[^\n]*\n            self\.remove_if_created\(res\)\n            raise/);
  });
});
