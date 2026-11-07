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
    expect(ops).toHaveLength(9);
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
import { bodyCases, documentedRejections, queryCases } from '../../src/generate/negative.js';

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
    expect(queryCases(op('GET /items')).map((c) => c.query)).toEqual([{ limit: 'abc' }, { limit: 0 }, { limit: 101 }]);
  });

  it('only uses rejections the spec documents', () => {
    expect(documentedRejections(op('GET /health'))).toEqual({ validation: [], notFound: false, unauthorized: false });
    expect(documentedRejections(op('POST /items')).validation).toEqual(['400']);
    expect(documentedRejections(op('POST /admin/reset')).unauthorized).toBe(true);
  });
});
