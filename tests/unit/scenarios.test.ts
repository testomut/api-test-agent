import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Ajv } from 'ajv';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { findPython, generate } from '../../src/generate/generate.js';
import { validateScenarios } from '../../src/scenarios/dsl.js';
import { scenarioUid } from '../../src/cases/ids.js';
import { operationUid } from '../../src/change/normalize.js';
import { validateRegistry } from '../../src/cases/validate.js';
import { normalizeSpec } from '../../src/change/normalize.js';

/** Stage 8 (docs/SUPPORT_MATRIX.md): CRUD flows and reviewed business scenarios. */

const demo = await loadSpec('demo-api/openapi.yaml');
const ops = buildCatalog(demo.doc);
const file = JSON.parse(await readFile('demo-api/scenarios.json', 'utf8'));
const schema = JSON.parse(await readFile('schemas/scenarios.schema.json', 'utf8'));

describe('stage 8: scenario model', () => {
  it('the demo scenarios file matches its JSON Schema and the spec', () => {
    expect(new Ajv({ allErrors: true }).validate(schema, file)).toBe(true);
    const r = validateScenarios(file, ops);
    expect(r.errors).toEqual([]);
    expect(r.scenarios.map((s) => s.primaryOp.key)).toEqual(['GET /items/{itemId}', 'GET /items/{itemId}']);
  });

  it('strict validation: unknown operation, undefined variable, undocumented status, no cleanup, primary not an action', () => {
    const bad = structuredClone(file);
    const s0 = bad.scenarios[0];
    s0.steps[1].params.itemId = '{nope}';
    s0.steps[1].expect = '418';
    s0.steps.pop(); // no cleanup although the scenario creates data
    s0.primary = 'create';
    bad.scenarios[1].steps[0].operationId = 'noSuchOp';
    bad.scenarios[1].id = 'items.read-created'; // duplicate external ID
    const errors = validateScenarios(bad, ops).errors.map((e) => `${e.pointer}: ${e.reason}`);
    for (const want of ['"{nope}" is not saved', '418 is not documented', 'no cleanup step', 'phase "action"', 'operation "noSuchOp" is not in the spec', 'duplicate id']) {
      expect(errors.some((e) => e.includes(want)), want).toBe(true);
    }
  });

  it('generated: one test per scenario in the primary operation folder, ID from the external ID, cleanup in finally; TS and Python agree', async () => {
    const scenarios = validateScenarios(file, ops).scenarios;
    const out = async (lang: 'typescript' | 'python') => {
      const dir = await mkdtemp(join(tmpdir(), 'ata-scn-'));
      const res = await generate(demo, ops, { outDir: dir, version: 'test', lang, scenarios });
      return { dir, res, reg: JSON.parse(await readFile(join(dir, '_support/cases.json'), 'utf8')), read: (f: string) => readFile(join(dir, f), 'utf8') };
    };
    const ts = await out('typescript');
    const py = await out('python');
    const steps = scenarios[0].steps.map((st) => ({ operationUid: operationUid(st.op.method, st.op.path.replace(/\{[^}]*\}/g, '{}')), phase: st.phase }));
    const uid = scenarioUid('business', steps, 'items.read-created');
    expect(ts.reg.cases[`ata:${uid}:scenario:positive:lifecycle:business-rule`]).toBeDefined();
    expect(ts.reg.scenarios[uid]).toMatchObject({ scenarioType: 'business', externalId: 'items.read-created', primaryOperationUid: operationUid('GET', '/items/{}') });
    // The title is not part of the identity.
    const renamed = structuredClone(scenarios);
    renamed[0].title = 'another title';
    expect(scenarioUid('business', steps, renamed[0].id)).toBe(uid);

    const text = await ts.read('items/get-by-id/scenarios.spec.ts');
    expect(text).toMatch(/an item that was just created can be read by its id[\s\S]*vars\['itemId'\] = readPointer\(body0, '\/id'\);[\s\S]*\} finally \{[\s\S]*reportCleanupFailure\('DELETE \/items\/\{itemId\}'/);
    const active = (reg: any) => Object.keys(reg.cases).filter((k) => !reg.cases[k].status).sort();
    expect(active(py.reg)).toEqual(active(ts.reg));
    expect(validateRegistry(await ts.read('_support/cases.json'), normalizeSpec(await readFile('demo-api/openapi.yaml', 'utf8'), 'demo')).errors).toEqual([]);
    expect(await py.read('items/get_by_id/test_scenarios.py')).toContain('def test_items_read_created(api):');
    const compiled = spawnSync(findPython(), ['-m', 'py_compile', ...py.res.files.filter((f) => f.endsWith('.py'))], { encoding: 'utf8' });
    if (!compiled.error) expect(compiled.status, compiled.stderr).toBe(0);
  });

  it('CRUD: a repeated delete gets the documented 404', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ata-del-'));
    await generate(demo, ops, { outDir: dir, version: 'test' });
    const text = await readFile(join(dir, 'items/delete-by-id/scenarios.spec.ts'), 'utf8');
    expect(text).toMatch(/deleting the same resource again gets the documented 404[\s\S]*expectStatus\(res, \['404'\]/);
  });
});
