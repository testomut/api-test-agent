import { describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTarget, loadConfig } from '../../src/config.js';
import { parsePostman } from '../../src/discover/postman.js';
import { PlaywrightAnalyzer, normalizeUrl } from '../../src/discover/playwright-tests.js';
import { analyzeProject, matchOperation } from '../../src/discover/analyze.js';
import { classify } from '../../src/discover/scan.js';
import { initProject } from '../../src/init.js';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';

const EX = 'examples/legacy-project';
const spec = await loadSpec('demo-api/openapi.yaml');
const ops = buildCatalog(spec.doc);

describe('config', () => {
  it('classifies targets so writes never go to production by accident', () => {
    expect(classifyTarget('http://localhost:3100')).toBe('local');
    expect(classifyTarget('https://api.staging.shop.com')).toBe('test');
    expect(classifyTarget('https://qa-api.shop.com')).toBe('test');
    expect(classifyTarget('https://api.prod.shop.com')).toBe('production');
    expect(classifyTarget('https://api.shop.com')).toBe('unknown');
  });

  it('reads .env, real environment variables win', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ata-'));
    await writeFile(join(dir, '.env'), 'API_BASE_URL=http://from-file\nAPI_TESTS_DIR=tests/contract\n');
    const env: NodeJS.ProcessEnv = { API_BASE_URL: 'http://from-env' };
    const c = loadConfig(dir, env);
    expect(c.baseUrl).toBe('http://from-env');
    expect(c.testsDir).toBe('tests/contract');
  });
});

describe('scan', () => {
  it('tells API tests from UI tests', () => {
    expect(classify('a.spec.ts', "import { test } from '@playwright/test'; test('x', async ({ request }) => { await request.get('/a'); });")).toBe('playwright-api');
    expect(classify('b.spec.ts', "import { test } from '@playwright/test'; test('x', async ({ page }) => { await page.goto('/'); });")).toBe('playwright-ui');
    expect(classify('c.json', '{"info":{"_postman_id":"1"}}')).toBe('postman-collection');
  });
});

describe('postman', () => {
  const c = parsePostman(JSON.parse(readFileSync(`${EX}/postman/inventory.postman_collection.json`, 'utf8')), 'file');

  it('flattens folders and normalises {{vars}} in paths', () => {
    expect(c.requests.map((r) => `${r.method} ${r.path}`)).toContain('GET /items/{itemId}');
    expect(c.requests.find((r) => r.name === 'Create item')?.statuses).toEqual([201]);
    expect(c.requests.find((r) => r.name === 'Delete item')?.statuses).toEqual([204]);
  });

  it('builds variable chains from pm.*.set → {{var}}', () => {
    expect(c.edges.map((e) => `${e.from.name} → ${e.to.name} (${e.variable})`)).toEqual(['Create item → Get item (itemId)', 'Create item → Delete item (itemId)']);
  });

  it('flags hard-coded auth', () => {
    expect(c.requests.find((r) => r.name === 'Delete item')?.hardcodedAuth).toBe(true);
  });
});

describe('playwright analyzer', () => {
  const analyzer = new PlaywrightAnalyzer();
  for (const f of ['helpers/items-api.ts', 'fixtures.ts']) analyzer.indexHelpers(f, readFileSync(`${EX}/${f}`, 'utf8'));
  const legacy = analyzer.analyzeTestFile('tests/items.test.ts', readFileSync(`${EX}/tests/items.test.ts`, 'utf8'));
  const lifecycle = analyzer.analyzeTestFile('tests/items-lifecycle.spec.ts', readFileSync(`${EX}/tests/items-lifecycle.spec.ts`, 'utf8'));

  it('normalises URLs', () => {
    expect(normalizeUrl('https://h.example.com/items?limit=5')).toBe('/items');
    expect(normalizeUrl('{BASE}/items/{id}')).toBe('/items/{id}');
    expect(normalizeUrl('items')).toBe('/items');
  });

  it('follows an id from beforeAll into later requests', () => {
    expect(legacy.edges.map((e) => `${e.from.method} ${e.from.path} → ${e.to.method} ${e.to.path}`)).toContain('POST /items → GET /items/{itemId}');
  });

  it('resolves fixtures and helpers as preconditions', () => {
    const t = lifecycle.tests[0];
    expect(t.preconditions.some((c) => c.method === 'POST' && c.via === 'item')).toBe(true);
    expect(t.polarity).toBe('positive');
    expect(lifecycle.edges.some((e) => e.from.method === 'POST' && e.to.method === 'DELETE')).toBe(true);
  });

  it('classifies positive and negative tests by the first asserted status', () => {
    expect(legacy.tests.find((t) => t.title.endsWith('item without name is rejected'))?.polarity).toBe('negative');
    expect(legacy.tests.find((t) => t.title.endsWith('get item'))?.polarity).toBe('positive');
  });

  it('reports quality issues', () => {
    const codes = legacy.issues.map((i) => i.code);
    for (const c of ['hardcoded-secret', 'hardcoded-url', 'no-cleanup', 'status-only', 'order-dependent']) expect(codes).toContain(c);
    expect(lifecycle.issues.map((i) => i.code)).not.toContain('no-cleanup');
  });
});

describe('project analysis', () => {
  it('maps calls to spec operations, including undocumented ones', () => {
    expect(matchOperation('GET', '/items/{item.id}', ops)).toBe('GET /items/{itemId}');
    expect(matchOperation('GET', '/api/v1/items', ops)).toBe('GET /items');
    expect(matchOperation('GET', '/version', ops)).toBe('GET /version');
  });

  it('builds the dependency and coverage map from tests, Postman and links', async () => {
    const a = await analyzeProject({ root: EX, testsDir: 'tests/api', doc: spec.doc, ops });
    const sources = new Set(a.edges.filter((e) => e.from === 'POST /items' && e.to === 'GET /items/{itemId}').map((e) => e.source));
    expect([...sources].sort()).toEqual(['existing-tests', 'openapi-links', 'postman']);
    expect(a.notInSpec).toEqual(['GET /version']);
    expect(a.inventory.find((f) => f.kind === 'playwright-ui')?.path).toBe('tests/e2e/home.spec.ts');
    expect(a.proposals.filter((p) => p.kind === 'move-test')).toHaveLength(7);
  });
});

describe('init', () => {
  it('is idempotent and never overwrites user values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ata-init-'));
    await cp(EX, dir, { recursive: true });
    await writeFile(join(dir, '.gitignore'), 'node_modules/\n');
    const first = await initProject(dir, { baseUrl: 'http://localhost:3100', testsDir: 'tests/api', needsToken: true });
    expect(first.created).toEqual(expect.arrayContaining(['.env', '.env.example', 'playwright.config.ts', '.claude/skills/api-test-writer']));
    await writeFile(join(dir, '.env'), (await readFile(join(dir, '.env'), 'utf8')).replace('API_TOKEN=', 'API_TOKEN=secret-value'));
    const second = await initProject(dir, { baseUrl: 'http://other', testsDir: 'tests/api' });
    expect(second.created).toEqual([]);
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain('API_TOKEN=secret-value');
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain('API_BASE_URL=http://localhost:3100');
    const gi = await readFile(join(dir, '.gitignore'), 'utf8');
    expect(gi.match(/^\.env$/gm)).toHaveLength(1);
    expect(gi).toContain('node_modules/');
  });
});
