import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Ajv } from 'ajv';
import { stringify } from 'yaml';
import { base32, normalizePath, normalizeSpec, operationUid } from '../../src/change/normalize.js';
import { AUTO_LINK, MIN_LEAD, REVIEW_LINK, mapChanges } from '../../src/change/map-changes.js';
import { INSTALL_HINT, SUPPORTED_OASDIFF_VERSION, applyVerdicts, preflight } from '../../src/change/oasdiff.js';
import { exitCodeFor, parseFailOn, runDiff } from '../../src/change/diff.js';
import { isDeniedAddress, readSource } from '../../src/change/network.js';
import { ConfigError, type OpenApiChangeSet } from '../../src/change/types.js';

const FAKE = join(process.cwd(), 'tests/fixtures/change/fake-oasdiff.mjs');
const fakeEnv = (extra: Record<string, string> = {}) => ({ ...process.env, OASDIFF_BIN: FAKE, ...extra });

/** A small spec; `mutate` changes a deep copy. */
function spec(mutate: (d: any) => void = () => undefined, version = '3.1.0'): any {
  const d: any = {
    openapi: version,
    info: { title: 'Shop', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      '/brands': {
        get: { operationId: 'getBrands', responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Brand' } } } } } } },
        post: {
          operationId: 'storeBrand',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BrandRequest' } } } },
          responses: { '201': { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Brand' } } } }, '422': { description: 'invalid' } },
        },
      },
      '/brands/{brandId}': {
        get: {
          operationId: 'getBrand',
          parameters: [{ name: 'brandId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Brand' } } } }, '404': { description: 'missing' } },
        },
      },
      '/products': {
        get: {
          operationId: 'getProducts',
          parameters: [{ name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } }],
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, price: { type: 'number' } } } } } } } } } },
        },
      },
    },
    components: {
      schemas: {
        BrandRequest: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 50, example: 'new brand' }, slug: { type: 'string' } } },
        Brand: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string', nullable: undefined } } },
      },
    },
  };
  const copy = structuredClone(d);
  mutate(copy);
  return copy;
}

const diffOf = (a: any, b: any) => mapChanges(normalizeSpec(stringify(a), 'base'), normalizeSpec(stringify(b), 'head'));
const kinds = (r: { changes: { kind: string; facet?: string }[] }) => r.changes.map((c) => (c.facet ? `${c.kind}:${c.facet}` : c.kind)).sort();

describe('operationUid and normalizedPath', () => {
  it('RFC 4648 base32, uppercase, no padding', () => {
    expect(base32(Buffer.from('f'))).toBe('MY');
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('is op_ + 12 base32 chars of sha256(METHOD + " " + normalizedPath); parameter names are not identity', () => {
    expect(normalizePath('/brands/{id}')).toBe('/brands/{}');
    expect(normalizePath('/brands/{brandId}/')).toBe('/brands/{}/'); // trailing slash kept
    expect(operationUid('get', '/brands/{}')).toMatch(/^op_[A-Z2-7]{12}$/);
    expect(operationUid('get', normalizePath('/brands/{id}'))).toBe(operationUid('GET', normalizePath('/brands/{brandId}')));
    expect(operationUid('get', '/brands')).not.toBe(operationUid('get', '/brands/'));
    expect(operationUid('get', '/brands')).not.toBe(operationUid('post', '/brands'));
  });
});

describe('normalization: no changes for equivalent specs', () => {
  it('identical specs, key order, descriptions', () => {
    expect(diffOf(spec(), spec()).changes).toEqual([]);
    const reordered = spec((d) => {
      d.paths = Object.fromEntries(Object.entries(d.paths).reverse());
      d.paths['/brands'].post.description = 'Creates a brand';
      d.components.schemas.Brand.description = 'A brand';
    });
    expect(diffOf(spec(), reordered).changes).toEqual([]);
  });

  it('$ref moved / renamed, inline ↔ component, equivalent allOf', () => {
    const renamed = spec((d) => {
      d.components.schemas.NewBrandInput = d.components.schemas.BrandRequest;
      delete d.components.schemas.BrandRequest;
      d.paths['/brands'].post.requestBody.content['application/json'].schema = { $ref: '#/components/schemas/NewBrandInput' };
      d.paths['/brands/{brandId}'].get.responses['200'].content['application/json'].schema = structuredClone(d.components.schemas.Brand); // inline
    });
    expect(diffOf(spec(), renamed).changes).toEqual([]);
    const allOf = spec((d) => {
      d.components.schemas.BrandRequest = {
        allOf: [
          { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 50, example: 'new brand' } } },
          { type: 'object', properties: { slug: { type: 'string' } } },
        ],
      };
    });
    expect(diffOf(spec(), allOf).changes).toEqual([]);
  });

  it('OpenAPI 3.0 nullable: true ≡ 3.1 type: [x, "null"]', () => {
    const v30 = spec((d) => (d.components.schemas.Brand.properties.slug = { type: 'string', nullable: true }), '3.0.3');
    const v31 = spec((d) => (d.components.schemas.Brand.properties.slug = { type: ['string', 'null'] }), '3.1.0');
    expect(diffOf(v30, v31).changes).toEqual([]);
  });
});

describe('change detection', () => {
  it('operation added and removed', () => {
    const r = diffOf(spec(), spec((d) => {
      delete d.paths['/products'];
      d.paths['/categories'] = { get: { operationId: 'getCategories', responses: { '200': { description: 'ok' } } } };
    }));
    expect(kinds(r)).toEqual(['operation-added', 'operation-removed']);
    expect(r.changes.find((c) => c.kind === 'operation-added')).toMatchObject({ operationKey: 'GET /categories', breaking: 'no' });
  });

  it('operationId renamed on the same path keeps the operationUid', () => {
    const r = diffOf(spec(), spec((d) => (d.paths['/brands/{brandId}'].get.operationId = 'showBrand')));
    expect(r.changes).toEqual([expect.objectContaining({ kind: 'operationId-renamed', before: 'getBrand', after: 'showBrand', operationUid: operationUid('GET', '/brands/{}') })]);
  });

  it('path parameter renamed: same identity, one parameter-renamed, no contract change', () => {
    const r = diffOf(spec(), spec((d) => {
      const item = d.paths['/brands/{brandId}'];
      item.get.parameters[0].name = 'id';
      d.paths['/brands/{id}'] = item;
      delete d.paths['/brands/{brandId}'];
    }));
    expect(r.changes).toEqual([expect.objectContaining({ kind: 'parameter-renamed', before: ['brandId'], after: ['id'], breaking: 'no', operationKey: 'GET /brands/{id}' })]);
  });

  it('moved with the same operationId (0.95) keeps the base operationUid', () => {
    const r = diffOf(spec(), spec((d) => {
      d.paths['/v2/brands/{brandId}'] = d.paths['/brands/{brandId}'];
      delete d.paths['/brands/{brandId}'];
    }));
    expect(r.changes).toEqual([expect.objectContaining({ kind: 'operation-moved', confidence: 0.95, operationUid: operationUid('GET', '/brands/{}'), after: 'GET /v2/brands/{brandId}' })]);
  });

  it('moved and renamed with an identical contract (fingerprint, 0.90)', () => {
    const r = diffOf(spec(), spec((d) => {
      d.paths['/v2/brand/{brandId}'] = d.paths['/brands/{brandId}'];
      d.paths['/v2/brand/{brandId}'].get.operationId = 'fetchBrand';
      delete d.paths['/brands/{brandId}'];
    }));
    expect(r.changes).toEqual([expect.objectContaining({ kind: 'operation-moved', confidence: 0.9 })]);
    expect(r.changes[0].review).toBeUndefined();
  });

  it('a weak match stays removed + added; a partial one lands in review', () => {
    // Different operationId, response and parameters: score below 0.70.
    const weak = diffOf(spec(), spec((d) => {
      d.paths['/v2/things/{thingId}'] = { get: { operationId: 'getThing', parameters: [{ name: 'thingId', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'ok' } } } };
      delete d.paths['/brands/{brandId}'];
    }));
    expect(kinds(weak)).toEqual(['operation-added', 'operation-removed']);
    // Same operationId but another GET also carries it: no unique exact rule, score ≥ 0.70 → review.
    const partial = diffOf(spec(), spec((d) => {
      const moved = structuredClone(d.paths['/brands/{brandId}']);
      moved.get.responses['400'] = { description: 'bad id' }; // response fingerprint differs
      d.paths['/catalog/brands/{brandId}'] = moved;
      d.paths['/catalog/brands-copy/{brandId}'] = structuredClone(moved);
      d.paths['/catalog/brands-copy/{brandId}'].get.parameters[0].schema = { type: 'integer' };
      delete d.paths['/brands/{brandId}'];
    }));
    const moved = partial.changes.find((c) => c.kind === 'operation-moved');
    expect(moved?.review).toBe(true);
    expect(moved!.confidence!).toBeGreaterThanOrEqual(REVIEW_LINK);
    expect(AUTO_LINK - REVIEW_LINK).toBeCloseTo(0.2);
    expect(MIN_LEAD).toBe(0.15);
  });

  it('required, min/max, enum and type changes, with request vs response direction', () => {
    const r = diffOf(spec(), spec((d) => {
      const req = d.components.schemas.BrandRequest;
      req.properties.name.maxLength = 100;
      req.required = ['name', 'slug'];
      req.properties.slug.enum = ['a', 'b'];
      d.paths['/products'].get.parameters[0].schema.minimum = 0;
      d.paths['/products'].get.responses['200'].content['application/json'].schema.properties.data.items.properties.price.type = 'string';
    }));
    const by = (facet: string) => r.changes.filter((c) => c.facet === facet).map((c) => ({ scope: c.scope, op: c.operationKey, before: c.before, after: c.after }));
    expect(by('maxLength')).toEqual([{ scope: 'request', op: 'POST /brands', before: 50, after: 100 }]);
    expect(by('required')).toEqual([{ scope: 'request', op: 'POST /brands', before: false, after: true }]);
    expect(by('enum')).toEqual([{ scope: 'request', op: 'POST /brands', before: undefined, after: ['a', 'b'] }]);
    expect(by('minimum')).toEqual([{ scope: 'request', op: 'GET /products', before: 1, after: 0 }]);
    expect(by('type')).toEqual([{ scope: 'response', op: 'GET /products', before: 'number', after: 'string' }]);
    expect(r.changes.every((c) => c.testRelevant)).toBe(true);
  });

  it('example / default changes are their own non-breaking, test-relevant kind; servers are reported only', () => {
    const r = diffOf(spec(), spec((d) => {
      d.components.schemas.BrandRequest.properties.name.example = 'other brand';
      d.servers = [{ url: 'https://api2.example.com' }];
    }));
    expect(r.changes.find((c) => c.kind === 'example-changed')).toMatchObject({ breaking: 'no', testRelevant: true, before: 'new brand', after: 'other brand', scope: 'request' });
    expect(r.changes.find((c) => c.kind === 'servers-changed')).toMatchObject({ testRelevant: false });
  });

  it('examples inside an added / removed response belong to that change, not to example-changed', () => {
    const r = diffOf(spec((d) => (d.components.schemas.Brand.properties.id.example = 'b1')), spec((d) => {
      d.components.schemas.Brand.properties.id.example = 'b1';
      const post = d.paths['/brands'].post;
      post.responses['200'] = post.responses['201'];
      delete post.responses['201'];
    }));
    expect(kinds(r)).toEqual(['response-changed', 'response-changed']);
  });

  it('a renamed path parameter does not move its example', () => {
    const base = spec((d) => (d.paths['/brands/{brandId}'].get.parameters[0].example = 'b1'));
    const r = diffOf(base, spec((d) => {
      const item = d.paths['/brands/{brandId}'];
      item.get.parameters[0] = { ...item.get.parameters[0], name: 'id', example: 'b1' };
      d.paths['/brands/{id}'] = item;
      delete d.paths['/brands/{brandId}'];
    }));
    expect(kinds(r)).toEqual(['parameter-renamed']);
  });

  it('duplicate x-api-test-agent-id is BLOCKED with both pointers and no automatic identity', () => {
    const dup = spec((d) => {
      d.paths['/brands'].get['x-api-test-agent-id'] = 'brands.list';
      d.paths['/products'].get['x-api-test-agent-id'] = 'brands.list';
    });
    const r = diffOf(spec(), dup);
    expect(r.blocked).toEqual([expect.objectContaining({ code: 'DUPLICATE_API_TEST_AGENT_ID', pointers: ['/paths/~1brands/get/x-api-test-agent-id', '/paths/~1products/get/x-api-test-agent-id'] })]);
  });
});

describe('oasdiff layer', () => {
  it('pins one supported version, named in the install hint', () => {
    expect(SUPPORTED_OASDIFF_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(INSTALL_HINT).toContain(`v${SUPPORTED_OASDIFF_VERSION}`);
  });

  it('preflight blocks $dynamicRef and components.pathItems', () => {
    expect(preflight({ components: { schemas: { A: { $dynamicRef: '#node' } } } }, 'head')[0]).toMatchObject({ code: 'OASDIFF_UNSUPPORTED_CONSTRUCT', pointers: ['/components/schemas/A/$dynamicRef'] });
    expect(preflight({ components: { pathItems: { P: {} } } }, 'head')[0].pointers).toEqual(['/components/pathItems']);
    expect(preflight(spec(), 'head')).toEqual([]);
  });

  it('maps changelog entries to verdicts by operation, facet and direction; no match stays unknown', () => {
    const r = diffOf(spec(), spec((d) => {
      d.components.schemas.BrandRequest.properties.name.maxLength = 10;
      d.paths['/products'].get.responses['200'].content['application/json'].schema.properties.data.items.properties.price.type = 'string';
      delete d.paths['/brands/{brandId}'];
    }));
    applyVerdicts(
      r.changes,
      [
        { id: 'request-property-max-length-decreased', level: 3, operation: 'POST', path: '/brands', text: 'the "name" request property maxLength was decreased' },
        { id: 'api-path-removed-without-deprecation', level: 3, operation: 'GET', path: '/brands/{brandId}' },
      ],
      (c) => ({ method: c.operationKey.split(' ')[0], paths: [c.operationKey.split(' ').slice(1).join(' ')] }),
    );
    expect(r.changes.find((c) => c.facet === 'maxLength')?.breaking).toBe('yes');
    expect(r.changes.find((c) => c.kind === 'operation-removed')?.breaking).toBe('yes');
    expect(r.changes.find((c) => c.facet === 'type')?.breaking).toBe('unknown');
  });
});

describe('diff command', () => {
  const files = async (base: any, head: any) => {
    const dir = await mkdtemp(join(tmpdir(), 'ata-diff-'));
    await writeFile(join(dir, 'base.yaml'), stringify(base));
    await writeFile(join(dir, 'head.yaml'), stringify(head));
    return { dir, base: join(dir, 'base.yaml'), head: join(dir, 'head.yaml'), out: join(dir, 'out') };
  };
  const opts = (f: { base?: string; head: string; out: string }, extra: Partial<Parameters<typeof runDiff>[0]> = {}) => ({
    base: f.base, head: f.head, out: f.out, format: 'markdown' as const, failOn: parseFailOn([]), allowNetwork: false, allowHosts: [], allowEngineVersionMismatch: false, env: fakeEnv(), ...extra,
  });

  it('writes changes.json valid against the schema, and changes.md', async () => {
    const f = await files(spec(), spec((d) => (d.components.schemas.BrandRequest.properties.name.maxLength = 100)));
    const r = await runDiff(opts(f));
    const json = JSON.parse(await readFile(join(f.out, 'changes.json'), 'utf8'));
    const ajv = new Ajv({ allErrors: true });
    const valid = ajv.validate(JSON.parse(await readFile('schemas/changes.schema.json', 'utf8')), json);
    expect(valid, JSON.stringify(ajv.errors)).toBe(true);
    expect(json).toMatchObject({ baseSource: 'flag', engine: { name: 'oasdiff', version: '1.34.1', versionMismatch: false } });
    expect(await readFile(join(f.out, 'changes.md'), 'utf8')).toContain('schema-constraint-changed · maxLength');
    expect(r.exitCode).toBe(0);
  });

  it('only descriptions changed: empty changes, "No test-relevant changes found", exit 0', async () => {
    const f = await files(spec(), spec((d) => (d.info.description = 'new words')));
    const r = await runDiff(opts(f));
    expect(r.set.changes).toEqual([]);
    expect(await readFile(join(f.out, 'changes.md'), 'utf8')).toContain('No test-relevant changes found.');
    expect(r.exitCode).toBe(0);
  });

  it('no baseline: BLOCKED BASE_SPEC_MISSING (snapshot without metadata), exit 1 under the default policy', async () => {
    const f = await files(spec(), spec());
    const tests = join(f.dir, 'tests');
    await (await import('node:fs/promises')).mkdir(join(tests, '_support'), { recursive: true });
    await writeFile(join(tests, '_support', 'openapi.snapshot.ts'), 'export const spec = {};\n');
    const r = await runDiff(opts({ head: f.head, out: f.out }, { testsDir: tests, env: fakeEnv({ GITHUB_BASE_REF: '' }) }));
    expect(r.set.blocked[0]).toMatchObject({ code: 'BASE_SPEC_MISSING' });
    expect(r.set.blocked[0].reason).toMatch(/snapshot: .*has no metadata/);
    expect(r.set.baseSource).toBeNull();
    expect(r.exitCode).toBe(1);
  });

  it('without --base: the head file at the Git merge base', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ata-mb-'));
    const run = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'test');
    await writeFile(join(dir, 'openapi.yaml'), stringify(spec()));
    run('add', '.');
    run('commit', '-qm', 'base');
    run('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const baseSha = run('rev-parse', 'HEAD').stdout.trim();
    run('checkout', '-qb', 'feature');
    await writeFile(join(dir, 'openapi.yaml'), stringify(spec((d) => (d.paths['/brands/{brandId}'].get.operationId = 'showBrand'))));
    run('commit', '-qam', 'rename');
    const r = await runDiff(opts({ head: join(dir, 'openapi.yaml'), out: join(dir, 'out') }, { env: fakeEnv({ GITHUB_BASE_REF: 'main' }) }));
    expect(r.set).toMatchObject({ baseSource: 'merge-base', baseRevision: baseSha, headRevision: run('rev-parse', 'HEAD').stdout.trim() });
    expect(r.set.changes.map((c) => c.kind)).toEqual(['operationId-renamed']);
  });

  it('configuration errors (exit 2): URL without --allow-network, missing oasdiff, version mismatch, unknown version output', async () => {
    const f = await files(spec(), spec());
    await expect(runDiff(opts({ ...f, head: 'https://example.com/openapi.json' }))).rejects.toThrow(/pass --allow-network/);
    await expect(runDiff(opts(f, { env: { ...process.env, OASDIFF_BIN: join(f.dir, 'nope.exe') } }))).rejects.toThrow(/does not exist.*Install oasdiff/);
    await expect(runDiff(opts(f, { env: { PATH: f.dir } }))).rejects.toThrow(/oasdiff was not found/);
    await expect(runDiff(opts(f, { env: fakeEnv({ FAKE_OASDIFF_VERSION: '1.30.0' }) }))).rejects.toThrow(/1\.30\.0 found, 1\.34\.1 expected/);
    await expect(runDiff(opts(f, { env: fakeEnv({ FAKE_OASDIFF_VERSION: 'garbage' }) }))).rejects.toThrow(/Unrecognized/);
    const warned: string[] = [];
    const r = await runDiff(opts(f, { allowEngineVersionMismatch: true, env: fakeEnv({ FAKE_OASDIFF_VERSION: '1.30.0' }), log: (m) => warned.push(m) }));
    expect(r.set.engine).toEqual({ name: 'oasdiff', version: '1.30.0', versionMismatch: true });
    expect(warned.join()).toMatch(/WARNING/);
  });

  it('uses the engine verdicts', async () => {
    const f = await files(spec(), spec((d) => (d.components.schemas.BrandRequest.properties.name.maxLength = 10)));
    const log = join(f.dir, 'changelog.json');
    await writeFile(log, JSON.stringify([{ id: 'request-property-max-length-decreased', level: 3, operation: 'POST', path: '/brands', text: 'name' }]));
    const r = await runDiff(opts(f, { failOn: parseFailOn(['breaking']), env: fakeEnv({ FAKE_OASDIFF_CHANGELOG: log }) }));
    expect(r.set.changes[0]).toMatchObject({ facet: 'maxLength', breaking: 'yes' });
    expect(r.exitCode).toBe(1);
  });

  it('OASDIFF_UNSUPPORTED_CONSTRUCT is a BLOCKED result, verdicts stay unknown', async () => {
    const f = await files(spec(), spec((d) => {
      d.components.schemas.BrandRequest.properties.name.maxLength = 10;
      d.components.schemas.Tree = { $dynamicAnchor: 'node', type: 'object' };
    }));
    const r = await runDiff(opts(f, { failOn: parseFailOn(['never']) }));
    expect(r.set.blocked.map((b) => b.code)).toEqual(['OASDIFF_UNSUPPORTED_CONSTRUCT']);
    expect(r.set.changes[0].breaking).toBe('unknown');
    expect(r.exitCode).toBe(0);
  });
});

describe('--fail-on and exit codes', () => {
  const set = (changes: Partial<OpenApiChangeSet['changes'][number]>[], blocked = 0): OpenApiChangeSet => ({
    baseRevision: 'a', headRevision: 'b', baseSource: 'flag', engine: { name: 'oasdiff', version: '1.34.1', versionMismatch: false },
    changes: changes.map((c) => ({ kind: 'request-changed', operationUid: 'op_AAAAAAAAAAAA', operationKey: 'GET /x', breaking: 'no', testRelevant: true, ...c })) as any,
    blocked: Array.from({ length: blocked }, () => ({ code: 'BASE_SPEC_MISSING', reason: 'x' })),
  });

  it('default is blocked; values combine; never stands alone', () => {
    expect(parseFailOn([])).toEqual(['blocked']);
    expect(parseFailOn(['breaking', 'unknown'])).toEqual(['breaking', 'unknown']);
    expect(parseFailOn(['breaking,blocked'])).toEqual(['breaking', 'blocked']);
    expect(() => parseFailOn(['never', 'breaking'])).toThrow(ConfigError);
    expect(() => parseFailOn(['mismatch'])).toThrow(/Unknown --fail-on/);
  });

  it('matrix', () => {
    const cases: [Partial<OpenApiChangeSet['changes'][number]>[], number, string[], number][] = [
      [[], 0, ['blocked'], 0],
      [[], 1, ['blocked'], 1],
      [[], 1, ['never'], 0],
      [[{ breaking: 'yes' }], 0, ['blocked'], 0],
      [[{ breaking: 'yes' }], 0, ['breaking'], 1],
      [[{ breaking: 'unknown' }], 0, ['breaking'], 0],
      [[{ breaking: 'unknown' }], 0, ['unknown'], 1],
      [[{ breaking: 'unknown' }], 1, ['breaking', 'unknown'], 1],
      [[{ breaking: 'no' }], 1, ['breaking', 'unknown'], 0],
      [[{ breaking: 'yes' }], 1, ['never'], 0],
    ];
    for (const [changes, blocked, policy, code] of cases) expect(exitCodeFor(set(changes, blocked), parseFailOn(policy)), JSON.stringify({ changes, blocked, policy })).toBe(code);
  });
});

describe('network guards', () => {
  it('denies loopback, private, link-local and metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isDeniedAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(isDeniedAddress(ip), ip).toBe(false);
  });

  it('a URL needs --allow-network; denied hosts need --allow-host; --allow-host restricts', async () => {
    await expect(readSource('https://example.com/a.json', { allowNetwork: false, allowHosts: [] })).rejects.toThrow(/--allow-network/);
    await expect(readSource('http://localhost:9/a.json', { allowNetwork: true, allowHosts: [] })).rejects.toThrow(/denied by default/);
    await expect(readSource('http://169.254.169.254/latest', { allowNetwork: true, allowHosts: [] })).rejects.toThrow(/denied by default/);
    await expect(readSource('https://example.com/a.json', { allowNetwork: true, allowHosts: ['api.example.org'] })).rejects.toThrow(/not in --allow-host/);
  });
});

// Real engine: runs only where the pinned oasdiff is installed (CI installs it).
const realOasdiff = (() => {
  const bin = process.env.OASDIFF_BIN ?? 'oasdiff';
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  return !r.error && (r.stdout + r.stderr).includes(SUPPORTED_OASDIFF_VERSION) ? bin : undefined;
})();

describe.skipIf(!realOasdiff)(`Toolshop fixture against oasdiff ${SUPPORTED_OASDIFF_VERSION}`, () => {
  it('an unchanged spec gives no changes; a decreased maxLength is breaking', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ata-ts-'));
    const doc = JSON.parse(await readFile('tests/fixtures/change/toolshop.json', 'utf8'));
    const head = structuredClone(doc);
    const props = head.components.schemas.BrandRequest.properties;
    props.name.maxLength = 10;
    await writeFile(join(dir, 'head.json'), JSON.stringify(head));
    const env = { ...process.env, OASDIFF_BIN: realOasdiff! };
    const same = await runDiff({ base: 'tests/fixtures/change/toolshop.json', head: 'tests/fixtures/change/toolshop.json', out: join(dir, 'same'), format: 'json', failOn: ['blocked'], allowNetwork: false, allowHosts: [], allowEngineVersionMismatch: false, env });
    expect(same.set.changes).toEqual([]);
    const changed = await runDiff({ base: 'tests/fixtures/change/toolshop.json', head: join(dir, 'head.json'), out: join(dir, 'changed'), format: 'json', failOn: ['breaking'], allowNetwork: false, allowHosts: [], allowEngineVersionMismatch: false, env });
    expect(changed.set.changes.filter((c) => c.facet === 'maxLength').every((c) => c.breaking === 'yes')).toBe(true);
  });
});
