import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stringify, parse } from 'yaml';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { generate, findPython } from '../../src/generate/generate.js';
import { ARRAY, CASE_RULE_VOCABULARY_VERSION, bodyPointer, encodeSegment, parseCaseId, scenarioUid } from '../../src/cases/ids.js';
import { canonicalJson } from '../../src/cases/registry.js';
import { validateManifest, validateRegistry } from '../../src/cases/validate.js';
import { normalizeSpec, operationUid } from '../../src/change/normalize.js';
import { runDiff } from '../../src/change/diff.js';

const demo = await loadSpec('demo-api/openapi.yaml');
const ops = buildCatalog(demo.doc);
const gen = async (doc = demo.doc, extra: Record<string, unknown> = {}, dir?: string) => {
  const out = dir ?? (await mkdtemp(join(tmpdir(), 'ata-ids-')));
  const r = await generate({ ...demo, doc } as any, buildCatalog(doc), { outDir: out, version: 'test', ...extra });
  return { dir: out, r, read: (f: string) => readFile(join(out, f), 'utf8'), registry: async () => JSON.parse(await readFile(join(out, '_support/cases.json'), 'utf8')) };
};

describe('case ID format', () => {
  it('encodes names: RFC 6901, then canonical percent-encoding; a bare * is the array element', () => {
    expect(['name', 'meta:tag', 'a/b', 'a~b', '%value', '*'].map(encodeSegment)).toEqual(['name', 'meta%3Atag', 'a~1b', 'a~0b', '%25value', '%2A']);
    expect(bodyPointer(['items', ARRAY, 'sku'])).toBe('/items/*/sku');
    expect(bodyPointer([])).toBe('');
  });

  it('parses six parts and rejects bad encoding, rules and combinations', () => {
    const uid = 'op_ABCDEFGHIJKL';
    const check = (rest: string) => {
      const r = parseCaseId(`ata:${uid}:${rest}`);
      return r.ok ? 'OK' : r.error.code;
    };
    expect(check('functional:positive:operation:documented-success')).toBe('OK');
    expect(check('contract:positive:response.body#:schema')).toBe('OK');
    expect(check('contract:negative:request.body#/meta%3Atag:maxLength')).toBe('OK');
    expect(check('contract:negative:request.query#/limit:maximum')).toBe('OK');
    expect(check('contract:negative:request.body#/meta:tag:maxLength')).toBe('INVALID_CASE_ID_ENCODING');
    expect(check('contract:negative:request.body#/x%3a:maxLength')).toBe('INVALID_CASE_ID_ENCODING');
    expect(check('functional:positive:operation:schema')).toBe('INVALID_CASE_RULE_FOR_SUITE');
    expect(check('contract:positive:request.body#/name:documented')).toBe('INVALID_CASE_LOCATION');
    expect(check('contract:negative:operation:documented-success')).toBe('INVALID_CASE_RULE_FOR_SUITE');
    expect(check('scenario:positive:lifecycle:crud')).toBe('INVALID_CASE_SUBJECT');
    expect(check('contract:negative:request.body#/name:maxLength50')).toBe('INVALID_CASE_RULE');
    expect(check('contract:negative:request.body#/name:x-acme-unicode')).toBe('OK');
  });

  it('scenarioUid: from the steps, or from an external ID only', () => {
    const steps = [{ operationUid: 'op_A', phase: 'setup' as const }, { operationUid: 'op_B', phase: 'action' as const }];
    expect(scenarioUid('crud', steps)).toMatch(/^scn_[A-Z2-7]{12}$/);
    expect(scenarioUid('crud', steps)).not.toBe(scenarioUid('business', steps));
    expect(scenarioUid('crud', steps, 'checkout')).toBe(scenarioUid('business', [], 'checkout'));
  });
});

describe('generated suites carry case IDs', () => {
  it('TypeScript: a caseId annotation on every test; registry, snapshot metadata and manifest written', async () => {
    const { r, read, registry, dir } = await gen();
    const functional = await read('items/get-by-id/functional.spec.ts');
    const uid = operationUid('GET', '/items/{}');
    expect(functional).toContain(`annotation: { type: 'caseId', description: 'ata:${uid}:functional:positive:operation:documented-success' }`);
    expect(functional).toContain(`'ata:${uid}:functional:negative:request.path#/itemId:not-found'`);
    for (const f of r.files.filter((x) => x.endsWith('.spec.ts'))) {
      const text = await readFile(f, 'utf8');
      expect((text.match(/  test\(/g) ?? []).length, f).toBe((text.match(/annotation: \{ type: 'caseId'/g) ?? []).length);
    }
    const reg = await registry();
    expect(reg.caseRuleVocabularyVersion).toBe(CASE_RULE_VOCABULARY_VERSION);
    expect(reg.operations[uid]).toEqual({ method: 'GET', path: '/items/{itemId}', normalizedPath: '/items/{}', operationId: 'getItem' });
    const covers = reg.cases[`ata:${operationUid('POST', '/items')}:contract:positive:response.body#:schema`].covers;
    expect(covers).toEqual(['contract:positive:response.content-type#/application~1json:documented', 'contract:positive:response.status#/201:documented']);
    const scenario = Object.values<any>(reg.scenarios).find((s) => s.primaryOperationUid === operationUid('PATCH', '/items/{}'));
    expect(scenario.steps.map((s: any) => s.phase)).toEqual(['setup', 'action', 'assertion', 'cleanup']);
    expect(Object.keys(scenario.roles)).toEqual(['create', 'read', 'update', 'delete']);
    expect(await read('_support/openapi.snapshot.meta.json')).toMatch(/"capturedRevision"/);
    expect(validateRegistry(await read('_support/cases.json'), normalizeSpec(await readFile('demo-api/openapi.yaml', 'utf8'), 'demo'))).toMatchObject({ syntaxValidation: 'passed', schemaValidation: 'passed', errors: [] });
    expect((await validateManifest(dir)).findings).toEqual([]);
  });

  it('a success response without a documented body is checked as a documented status, not a body schema', async () => {
    const d = parse(stringify(demo.doc));
    delete d.paths['/health'].get.responses['200'].content;
    const { registry, read } = await gen(d);
    const uid = operationUid('GET', '/health');
    const reg = await registry();
    expect(reg.cases[`ata:${uid}:contract:positive:response.status#/200:documented`]).toBeDefined();
    expect(reg.cases[`ata:${uid}:contract:positive:response.body#:schema`]).toBeUndefined();
    expect(validateRegistry(await read('_support/cases.json'), normalizeSpec(stringify(d), 'd')).errors).toEqual([]);
  });

  it('Python: api_case_id markers, registered in conftest; parametrized cases carry theirs', async () => {
    const { r, read } = await gen(demo.doc, { lang: 'python' });
    expect(await read('conftest.py')).toContain('"api_case_id(id): stable case ID from _support/cases.json"');
    const functional = await read('items/get_by_id/test_functional.py');
    expect(functional).toMatch(/@pytest\.mark\.positive\n@pytest\.mark\.api_case_id\("ata:op_[A-Z2-7]{12}:functional:positive:operation:documented-success"\)\ndef test_/);
    expect(await read('items/post/test_contract.py')).toContain('marks=pytest.mark.api_case_id("ata:');
    const py = r.files.filter((f) => f.endsWith('.py'));
    const compiled = spawnSync(findPython(), ['-m', 'py_compile', ...py], { encoding: 'utf8' });
    if (!compiled.error) expect(compiled.status, compiled.stderr).toBe(0);
  });

  it('IDs are stable: regenerating gives the same registry; a renamed path parameter keeps the operationUid', async () => {
    const first = await gen();
    const before = await first.read('_support/cases.json');
    await gen(demo.doc, {}, first.dir);
    expect(await first.read('_support/cases.json')).toBe(before);
    const renamed = parse(stringify(demo.doc));
    renamed.paths['/items/{id}'] = renamed.paths['/items/{itemId}'];
    delete renamed.paths['/items/{itemId}'];
    for (const op of Object.values<any>(renamed.paths['/items/{id}'])) for (const p of op?.parameters ?? []) if (p.name === 'itemId') p.name = 'id';
    for (const p of renamed.paths['/items/{id}'].parameters ?? []) if (p.name === 'itemId') p.name = 'id';
    await gen(renamed, {}, first.dir);
    const reg = await first.registry();
    const uid = operationUid('GET', '/items/{}');
    expect(reg.operations[uid]).toMatchObject({ path: '/items/{id}' });
    expect(reg.cases[`ata:${uid}:functional:negative:request.path#/id:not-found`]).toBeDefined();
    expect(reg.cases[`ata:${uid}:functional:negative:request.path#/itemId:not-found`]).toBeDefined(); // history is never deleted
  });

  it('a removed operation becomes a tombstone; its UID is never reused', async () => {
    const first = await gen();
    const smaller = parse(stringify(demo.doc));
    delete smaller.paths['/stats'];
    await gen(smaller, {}, first.dir);
    const reg = await first.registry();
    expect(reg.operations[operationUid('GET', '/stats')]).toMatchObject({ status: 'retired', retiredSpecHash: demo.hash, lastValidatedGeneratorVersion: 'test' });
    expect(validateRegistry(await first.read('_support/cases.json')).errors).toEqual([]);
  });
});

describe('registry validate', () => {
  const base = async () => JSON.parse(await (await gen()).read('_support/cases.json'));
  const run = (reg: any, spec?: any) => validateRegistry(canonicalJson(reg), spec);

  it('syntax only without a spec: "not-run"; non-canonical text is reported', async () => {
    const reg = await base();
    expect(run(reg)).toMatchObject({ syntaxValidation: 'passed', schemaValidation: 'not-run', errors: [] });
    expect(validateRegistry(JSON.stringify(reg)).errors.map((e) => e.code)).toEqual(['NON_CANONICAL_REGISTRY']);
  });

  it('entry ↔ ID mismatch, unknown subject, broken scenario, duplicate external ID, alias cycle, bad tombstone, newer vocabulary', async () => {
    const reg = await base();
    const [firstCase] = Object.keys(reg.cases);
    reg.cases[firstCase].rule = 'other';
    reg.cases['ata:op_ZZZZZZZZZZZZ:functional:positive:operation:documented-success'] = { subjectUid: 'op_ZZZZZZZZZZZZ', suiteType: 'functional', polarity: 'positive', location: 'operation', rule: 'documented-success' };
    const [scn] = Object.keys(reg.scenarios);
    reg.scenarios[scn].steps = reg.scenarios[scn].steps.slice(0, 1);
    const [a, b] = Object.keys(reg.operations);
    reg.operations[a].externalId = 'items.same';
    reg.operations[b].externalId = 'items.same';
    reg.externalIdAliases = { x: 'y', y: 'x' };
    reg.operations.op_AAAAAAAAAAAA = { method: 'GET', path: '/gone', normalizedPath: '/gone', status: 'retired' };
    const codes = run(reg).errors.map((e) => e.code);
    for (const c of ['CASE_ENTRY_MISMATCH', 'CASE_SUBJECT_NOT_FOUND', 'INVALID_SCENARIO', 'DUPLICATE_API_TEST_AGENT_ID', 'ALIAS_CYCLE', 'INVALID_TOMBSTONE']) expect(codes, c).toContain(c);
    expect(run({ ...(await base()), caseRuleVocabularyVersion: CASE_RULE_VOCABULARY_VERSION + 1 }).blocked.map((x) => x.code)).toEqual(['UNSUPPORTED_CASE_RULE_VOCABULARY']);
  });

  it('with a spec: missing operations, unknown fields and parameters, wildcards on non-arrays, rules that do not fit', async () => {
    const reg = await base();
    const post = operationUid('POST', '/items');
    const get = operationUid('GET', '/items');
    const add = (id: string) => {
      const p = parseCaseId(id);
      if (!p.ok) throw new Error(id);
      reg.cases[id] = { ...p.parts };
    };
    add(`ata:${post}:contract:negative:request.body#/nope:maxLength`);
    add(`ata:${post}:contract:negative:request.body#/name/*:maxLength`);
    add(`ata:${post}:contract:negative:request.body#/price:maxLength`);
    add(`ata:${get}:contract:negative:request.query#/missing:maximum`);
    const spec = normalizeSpec(await readFile('demo-api/openapi.yaml', 'utf8'), 'demo');
    const r = run(reg, spec);
    expect(r.schemaValidation).toBe('failed');
    expect(r.errors.map((e) => e.code).sort()).toEqual(['INVALID_ARRAY_WILDCARD', 'INVALID_CASE_LOCATION', 'INVALID_CASE_LOCATION', 'INVALID_CASE_RULE_FOR_SCHEMA']);
    const without = parse(await readFile('demo-api/openapi.yaml', 'utf8'));
    delete without.paths['/stats'];
    expect(run(await base(), normalizeSpec(stringify(without), 'x')).errors.map((e) => e.code)).toEqual(['ACTIVE_OPERATION_NOT_FOUND']);
  });
});

describe('manifest validate', () => {
  it('reports a modified or missing generated file; hand-written API subclasses are not checked', async () => {
    const { dir, read } = await gen();
    const manifest = JSON.parse(await read('_support/generation-manifest.json'));
    expect(manifest.files['_support/api/ItemsApi.ts'].ownership).toBe('hand-written');
    expect(manifest.files['items/get/functional.spec.ts']).toMatchObject({ ownership: 'generated', suiteType: 'functional' });
    await writeFile(join(dir, '_support/api/ItemsApi.ts'), '// mine\n');
    await writeFile(join(dir, 'items/get/functional.spec.ts'), (await read('items/get/functional.spec.ts')).replace(/\n/g, '\r\n')); // CRLF only: not a change
    expect((await validateManifest(dir)).findings).toEqual([]);
    await writeFile(join(dir, 'items/get/functional.spec.ts'), '// edited\n');
    const { rm } = await import('node:fs/promises');
    await rm(join(dir, 'items/get/contract.spec.ts'));
    expect((await validateManifest(dir)).findings.map((f) => f.code).sort()).toEqual(['GENERATED_FILE_MISSING', 'GENERATED_FILE_MODIFIED']);
  });
});

describe('diff uses the snapshot with metadata as the baseline', () => {
  it('no --base, no Git: the suite snapshot', async () => {
    const { dir } = await gen();
    const head = parse(stringify(demo.doc));
    head.paths['/items/{itemId}'].get.operationId = 'showItem';
    const headFile = join(dir, 'head.yaml');
    await writeFile(headFile, stringify(head));
    const r = await runDiff({
      head: headFile, out: join(dir, 'diff'), format: 'json', failOn: ['blocked'], allowNetwork: false, allowHosts: [], allowEngineVersionMismatch: false, testsDir: dir,
      env: { ...process.env, OASDIFF_BIN: join(process.cwd(), 'tests/fixtures/change/fake-oasdiff.mjs'), GITHUB_BASE_REF: '' },
    });
    expect(r.set).toMatchObject({ baseSource: 'snapshot', baseRevision: expect.stringMatching(/^sha256:|^[0-9a-f]{40}$|working tree/) });
    expect(r.set.changes.map((c) => c.kind)).toEqual(['operationId-renamed']);
    expect(existsSync(join(dir, 'diff', 'changes.json'))).toBe(true);
  });
});
