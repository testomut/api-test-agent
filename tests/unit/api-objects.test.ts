import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { generate } from '../../src/generate/generate.js';
import { buildApiIndex } from '../../src/generate/api-objects.js';

const demo = await loadSpec('demo-api/openapi.yaml');
const ops = buildCatalog(demo.doc);
const op = (key: string) => ops.find((o) => o.key === key)!;

describe('API objects', () => {
  it('groups operations by the first path segment and names methods after operationId', () => {
    const { refs, groups } = buildApiIndex(ops);
    expect(groups.map((g) => g.className).sort()).toEqual(['AdminApi', 'AuthApi', 'HealthApi', 'ItemsApi', 'MeApi', 'ReportsApi', 'StatsApi']);
    expect(refs.get(op('GET /items/{itemId}'))).toMatchObject({ prop: 'items', method: 'getItem', pathParams: ['itemId'] });
  });

  it('derives unique method names when operationId is missing or repeated', () => {
    const fake = (method: any, path: string, operationId?: string) => ({ ...op('GET /items'), method, path, operationId, key: `${method.toUpperCase()} ${path}`, params: [] });
    const { refs } = buildApiIndex([fake('get', '/brands', 'getBrands'), fake('get', '/brands/search', 'getBrands'), fake('delete', '/brands/{id}')] as any);
    expect([...refs.values()].map((r) => r.method)).toEqual(['getBrands', 'getBrands2', 'deleteBrandsById']);
  });

  it('generates bases every time but never overwrites the hand-written classes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ata-api-'));
    await generate(demo, ops, { outDir: dir, version: 'test' });
    const child = join(dir, '_support/api/ItemsApi.ts');
    const base = readFileSync(join(dir, '_support/api/generated/ItemsApiBase.ts'), 'utf8');
    expect(base).toContain('getItem(itemId: PathValue, options: RequestOptions = {}): Promise<APIResponse>');
    expect(readFileSync(child, 'utf8')).toContain('export class ItemsApi extends ItemsApiBase');
    expect(readFileSync(join(dir, '_support/api/generated/apis.ts'), 'utf8')).toContain('items: new ItemsApi(request),');

    writeFileSync(child, '// mine\nexport class ItemsApi {}\n');
    const r = await generate(demo, ops, { outDir: dir, version: 'test' });
    expect(readFileSync(child, 'utf8')).toBe('// mine\nexport class ItemsApi {}\n');
    expect(r.files.some((f) => f.endsWith('ItemsApi.ts'))).toBe(false);
  });

  it('tests call API objects; public operations and 401 checks go without credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ata-api-'));
    await generate(demo, ops, { outDir: dir, version: 'test' });
    const read = (f: string) => readFileSync(join(dir, f), 'utf8');
    expect(read('items/get-by-id/positive.spec.ts')).toContain('await api.items.getItem(id)');
    expect(read('health/get/positive.spec.ts')).toContain('async ({ publicApi })');
    expect(read('me/get/negative.spec.ts')).toContain('await publicApi.me.getMe()');
    expect(read('_support/items.resource.ts')).toContain('export async function create(api: Apis');
    for (const f of ['items/get-by-id/positive.spec.ts', 'me/get/negative.spec.ts']) expect(read(f)).not.toMatch(/request\.(get|post|fetch)\(/);
  });
});
