import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { findPython, generate } from '../../src/generate/generate.js';
import { boundaryValues } from '../../src/generate/boundaries.js';
import { sampleFromSchema } from '../../src/generate/sample.js';
import { operationUid } from '../../src/change/normalize.js';

/** Stage 7 (docs/SUPPORT_MATRIX.md): functional assertions and valid-data variants. */

const spec = await loadSpec('tests/fixtures/coverage/kitchen-sink.yaml');
const ops = buildCatalog(spec.doc);
const deps = JSON.parse(await readFile('tests/fixtures/coverage/kitchen-sink.deps.json', 'utf8'));

describe('stage 7: valid limits, sampler fixes, confirmed functional assertions', () => {
  it('boundary-valid values respect exclusive bounds, multipleOf and lengths', () => {
    expect(boundaryValues({ type: 'integer', minimum: 1, maximum: 50 })).toEqual([1, 50]);
    expect(boundaryValues({ type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 10 })).toEqual([1, 9]);
    expect(boundaryValues({ type: 'number', minimum: 0.5, maximum: 10, multipleOf: 0.5 })).toEqual([0.5, 10]);
    expect(boundaryValues({ type: 'integer', minimum: 1, maximum: 10, multipleOf: 4 })).toEqual([]); // no limit is itself a multiple
    expect(boundaryValues({ type: 'string', minLength: 2, maxLength: 5 })).toEqual(['xx', 'xxxxx']);
    expect(boundaryValues({ type: 'string', minLength: 2, pattern: '^a+$' })).toEqual([]); // never break a pattern
    expect(boundaryValues({ type: 'string', maxLength: 500 })).toEqual([]); // too long for a readable case ID
  });

  it('sampler: multipleOf, exclusive bounds (3.0 and 3.1), distinct items for uniqueItems', () => {
    const s = (schema: any) => (sampleFromSchema({}, schema) as any).value;
    expect(s({ type: 'number', minimum: 1, multipleOf: 0.75 })).toBe(1.5);
    expect(s({ type: 'integer', minimum: 3, exclusiveMinimum: true })).toBe(4);
    expect(s({ type: 'integer', minimum: 1, exclusiveMinimum: 5 })).toBe(6);
    expect(s({ type: 'array', minItems: 3, uniqueItems: true, items: { type: 'string' } })).toEqual(['api-agent', 'api-agent-1', 'api-agent-2']);
    expect(s({ type: 'array', minItems: 2, uniqueItems: true, items: { type: 'integer', minimum: 5 } })).toEqual([5, 6]);
    expect(sampleFromSchema({}, { type: 'array', minItems: 3, uniqueItems: true, items: { type: 'boolean' } }).ok).toBe(false);
    expect((sampleFromSchema({}, { type: 'integer', minimum: 1, maximum: 3, multipleOf: 5 }) as any).ok).toBe(false);
  });

  it('generated: one accepted-value test per limit, echoes from the deps file, the uncovered oneOf variant as a gap; TS and Python agree', async () => {
    const out = async (lang: 'typescript' | 'python') => {
      const dir = await mkdtemp(join(tmpdir(), 'ata-fv-'));
      const res = await generate(spec, ops, { outDir: dir, version: 'test', lang, deps, maxCases: 500 });
      return { dir, res, reg: JSON.parse(await readFile(join(dir, '_support/cases.json'), 'utf8')), read: (f: string) => readFile(join(dir, f), 'utf8') };
    };
    const ts = await out('typescript');
    const py = await out('python');
    const list = operationUid('GET', '/orders');
    for (const v of ['1', '50']) expect(ts.reg.cases[`ata:${list}:functional:positive:request.query#/limit/${v}:accepted-value`], v).toBeDefined();
    const active = (reg: any) => Object.keys(reg.cases).filter((k) => !reg.cases[k].status).sort();
    expect(active(py.reg)).toEqual(active(ts.reg));

    const create = await ts.read('orders/post/functional.spec.ts');
    expect(create).toContain(`expect(readPointer(created, '/total'), 'total returned as sent').toEqual((payload as Record<string, unknown>)['total']);`);
    expect(create).toContain(`expect(readPointer(created, '/status'), 'status returned as sent')`);
    expect(await py.read('orders/post/test_functional.py')).toContain(`assert read_pointer(res.json(), "/total") == payload["total"], "total returned as sent"`);

    const cov = ts.res.coverage.find((c) => c.operation === 'POST /orders')!;
    expect(cov.gaps).toContainEqual(expect.objectContaining({ code: 'UNCOVERED_VARIANT', location: 'request.body#/payment' }));
    const compiled = spawnSync(findPython(), ['-m', 'py_compile', ...py.res.files.filter((f) => f.endsWith('.py'))], { encoding: 'utf8' });
    if (!compiled.error) expect(compiled.status, compiled.stderr).toBe(0);
  });
});
