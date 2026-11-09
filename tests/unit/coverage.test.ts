import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, stringify } from 'yaml';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { checkCaseIds, findPython, generate } from '../../src/generate/generate.js';
import { parseCaseId } from '../../src/cases/ids.js';
import { validateRegistry } from '../../src/cases/validate.js';
import { canonicalJson } from '../../src/cases/registry.js';
import { normalizeSpec, operationUid } from '../../src/change/normalize.js';

/**
 * Coverage completeness (docs/SUPPORT_MATRIX.md): one physical test → one stable case ID,
 * the same cases in TypeScript and Python.
 */

const demo = await loadSpec('demo-api/openapi.yaml');

async function gen(doc: any, lang: 'typescript' | 'python' = 'typescript') {
  const dir = await mkdtemp(join(tmpdir(), 'ata-cov-'));
  const r = await generate({ ...demo, doc } as any, buildCatalog(doc), { outDir: dir, version: 'test', lang });
  const read = (f: string) => readFile(join(dir, f), 'utf8');
  return { dir, r, read, registry: async () => JSON.parse(await read('_support/cases.json')) };
}

/** Case IDs written into a generated file: annotations / caseId fields (TS) or api_case_id markers (Python). */
const idsIn = (text: string) => [...text.matchAll(/(?:description: |caseId: )'([^']+)'|api_case_id\("([^"]+)"\)/g)].map((m) => m[1] ?? m[2]).filter((x) => x !== 'c.caseId');

describe('stage 2: one case ID per physical test', () => {
  const withSort = () => {
    const d = parse(stringify(demo.doc));
    d.paths['/items'].get.parameters.push({ name: 'order', in: 'query', required: false, schema: { type: 'string', enum: ['asc', 'desc', 'asc'] } });
    d.paths['/items'].get.parameters.push({ name: 'flag', in: 'query', required: false, schema: { enum: [true, 'true', 1] } });
    return d;
  };

  it('each documented query value is its own test with its own accepted-value case ID (duplicates as strings dropped)', async () => {
    const { read, registry } = await gen(withSort());
    const text = await read('items/get/functional.spec.ts');
    const uid = operationUid('GET', '/items');
    for (const v of ['asc', 'desc', 'true', '1']) {
      const loc = v === 'asc' || v === 'desc' ? `request.query#/order/${v}` : `request.query#/flag/${v}`;
      expect(text).toContain(`'ata:${uid}:functional:positive:${loc}:accepted-value'`);
    }
    expect(text.match(/accepts documented flag=/g)).toHaveLength(2); // true and "true" are one value
    const ids = idsIn(text);
    expect(new Set(ids).size).toBe(ids.length);
    const reg = await registry();
    for (const id of ids) expect(reg.cases[id], id).toBeDefined();
    expect(validateRegistry(await read('_support/cases.json'), normalizeSpec(stringify(withSort()), 'x')).errors).toEqual([]);
  });

  it('Python renders the same values, each pytest.param with its own case ID', async () => {
    const ts = await gen(withSort());
    const py = await gen(withSort(), 'python');
    const tsIds = idsIn(await ts.read('items/get/functional.spec.ts')).sort();
    const pyIds = idsIn(await py.read('items/get/test_functional.py')).sort();
    expect(pyIds).toEqual(tsIds);
    expect(await py.read('items/get/test_functional.py')).toContain('def test_accepts_documented_query_value(api, params):');
    const compiled = spawnSync(findPython(), ['-m', 'py_compile', join(py.dir, 'items/get/test_functional.py')], { encoding: 'utf8' });
    if (!compiled.error) expect(compiled.status, compiled.stderr).toBe(0);
  });

  it('TypeScript and Python register the same cases for the demo API', async () => {
    const ts = await gen(demo.doc);
    const py = await gen(demo.doc, 'python');
    expect(Object.keys((await py.registry()).cases).sort()).toEqual(Object.keys((await ts.registry()).cases).sort());
  });

  it('accepted-value: a value the spec does not document is an invalid location', () => {
    const d = withSort();
    const uid = operationUid('GET', '/items');
    const id = `ata:${uid}:functional:positive:request.query#/order/random:accepted-value`;
    const parsed = parseCaseId(id);
    expect(parsed.ok).toBe(true);
    const reg = { schemaVersion: 1, caseRuleVocabularyVersion: 2, operations: { [uid]: { method: 'GET', path: '/items', normalizedPath: '/items' } }, cases: { [id]: (parsed as any).parts }, scenarios: {}, externalIdAliases: {}, externalScenarioIdAliases: {} };
    expect(validateRegistry(canonicalJson(reg), normalizeSpec(stringify(d), 'x')).errors.map((e) => e.code)).toEqual(['INVALID_CASE_LOCATION']);
    expect(parseCaseId(`ata:${uid}:functional:positive:request.query#/order:accepted-value`).ok).toBe(false); // needs a value
    expect(parseCaseId(`ata:${uid}:contract:negative:request.query#/order/asc:enum`).ok).toBe(false); // constraint rules: one segment
  });

  it('a case the generator no longer produces becomes a tombstone; producing it again reactivates it', async () => {
    const { dir } = await gen(withSort());
    const uid = operationUid('GET', '/items');
    const id = `ata:${uid}:functional:positive:request.query#/order/desc:accepted-value`;
    const without = withSort();
    without.paths['/items'].get.parameters.find((p: any) => p.name === 'order').schema.enum = ['asc'];
    await generate({ ...demo, doc: without } as any, buildCatalog(without), { outDir: dir, version: 'test' });
    const reg1 = JSON.parse(await readFile(join(dir, '_support/cases.json'), 'utf8'));
    expect(reg1.cases[id].status).toBe('retired');
    await generate({ ...demo, doc: withSort() } as any, buildCatalog(withSort()), { outDir: dir, version: 'test' });
    const reg2 = JSON.parse(await readFile(join(dir, '_support/cases.json'), 'utf8'));
    expect(reg2.cases[id].status).toBeUndefined();
  });

  it('checkCaseIds reports tests without an ID, shared IDs and unregistered IDs', () => {
    const r = checkCaseIds(
      [
        { test: 'a', caseId: 'x' },
        { test: 'b', caseId: 'x' },
        { test: 'c', caseId: null },
        { test: 'd', caseId: 'y' },
      ],
      new Set(['x']),
    );
    expect(r).toEqual({ tests: 4, missing: ['c'], duplicates: ['x'], unregistered: ['y'] });
  });
});
