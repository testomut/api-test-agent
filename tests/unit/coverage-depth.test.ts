import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { generate } from '../../src/generate/generate.js';
import { sampleFromSchema } from '../../src/generate/sample.js';
import { bodyVariants, requestValidator } from '../../src/generate/variants.js';
import { checkAuthConfig } from '../../src/generate/error-cases.js';
import { parseCaseId } from '../../src/cases/ids.js';
import { validateRegistry } from '../../src/cases/validate.js';
import { normalizeSpec } from '../../src/change/normalize.js';
import { cleanupProblems, compareBaseline } from '../../src/report/quality-gates.js';

/** Coverage depth (docs/SUPPORT_MATRIX.md): body variants, reviewed auth cases, gap codes, CI quality gates. */

const ks = await loadSpec('tests/fixtures/coverage/kitchen-sink.yaml');
const ksOps = buildCatalog(ks.doc);
const ksDeps = JSON.parse(await readFile('tests/fixtures/coverage/kitchen-sink.deps.json', 'utf8'));
const demo = await loadSpec('demo-api/openapi.yaml');
const demoOps = buildCatalog(demo.doc);
const demoDeps = JSON.parse(await readFile('demo-api/deps.json', 'utf8'));

async function gen(spec: typeof ks, ops: typeof ksOps, deps: unknown, lang: 'typescript' | 'python') {
  const dir = await mkdtemp(join(tmpdir(), 'ata-depth-'));
  const r = await generate(spec, ops, { outDir: dir, version: 'test', lang, deps: deps as any, maxCases: 500 });
  return { dir, r, read: (f: string) => readFile(join(dir, f), 'utf8') };
}
const idsIn = (text: string) => [...text.matchAll(/(?:description: |caseId: )'([^']+)'|api_case_id\("([^"]+)"\)/g)].map((m) => m[1] ?? m[2]).filter((x) => x !== 'c.caseId');

describe('positive request-body variants', () => {
  const schema = { $ref: '#/components/schemas/OrderInput' };
  const base = (sampleFromSchema(ks.doc, schema) as any).value;
  const r = bodyVariants(ks.doc, '/components/schemas/OrderInput', schema, base);
  const validate = requestValidator(ks.doc, '/components/schemas/OrderInput');
  const apply = (v: (typeof r.variants)[number]) => {
    const out = structuredClone(base);
    for (const p of v.remove ?? []) {
      const keys = p.split('/').slice(1);
      let n = out;
      for (const k of keys.slice(0, -1)) n = n[k];
      delete n[keys[keys.length - 1]];
    }
    if (v.set) out[v.set.pointer.slice(1)] = v.set.value;
    return out;
  };

  it('only the required fields: valid, and every optional field the schema allows is left out', () => {
    const v = r.variants.find((x) => x.kind === 'optional-omitted')!;
    const payload = apply(v);
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
    expect(Object.keys(payload).sort()).toEqual(['customer', 'items', 'total']);
  });

  it('another oneOf branch: only the branch the example does not send, and the payload is valid', () => {
    const variants = r.variants.filter((x) => x.kind === 'variant');
    expect(variants.map((x) => x.location)).toEqual(['request.body#/payment/@1']);
    expect(validate(apply(variants[0])), JSON.stringify(validate.errors)).toBe(true);
    for (const x of r.variants) expect(parseCaseId(`ata:op_AAAAAAAAAAAA:functional:positive:${x.location}:${x.kind}`).ok, x.location).toBe(true);
  });

  it('a field minProperties needs is kept (ItemPatch: one field must stay)', () => {
    const s = { $ref: '#/components/schemas/ItemPatch' };
    const p = bodyVariants(demo.doc, '/components/schemas/ItemPatch', s, { name: 'a', price: 1 });
    expect(p.variants[0].remove).toEqual(['/name']);
  });

  it('TypeScript and Python have the same variant cases; cleanup is guaranteed; the registry is valid', async () => {
    const ts = await gen(ks, ksOps, ksDeps, 'typescript');
    const py = await gen(ks, ksOps, ksDeps, 'python');
    const tsText = await ts.read('orders/post/functional.spec.ts');
    const pyText = await py.read('orders/post/test_functional.py');
    const pick = (ids: string[]) => ids.filter((id) => /:(optional-omitted|variant)$/.test(id)).sort();
    expect(pick(idsIn(pyText))).toEqual(pick(idsIn(tsText)));
    expect(pick(idsIn(tsText))).toHaveLength(2);
    expect(cleanupProblems(tsText.replace(/\r\n/g, '\n'), 'typescript')).toEqual([]);
    expect(cleanupProblems(pyText.replace(/\r\n/g, '\n'), 'python')).toEqual([]);
    const reg = validateRegistry(await ts.read('_support/cases.json'), normalizeSpec(await readFile('tests/fixtures/coverage/kitchen-sink.yaml', 'utf8'), 'ks'));
    expect(reg.errors).toEqual([]);
    expect(ts.r.coverage.flatMap((c) => c.gaps).filter((g) => g.code === 'UNCOVERED_VARIANT')).toEqual([]);
  });
});

describe('reviewed auth cases (deps "auth")', () => {
  it('403 for the operations named and 401 with an expired credential, from environment variables only', async () => {
    const ts = await gen(demo, demoOps, demoDeps, 'typescript');
    const text = await ts.read('me/get/functional.spec.ts');
    expect(text).toContain('process.env.API_FORBIDDEN_TOKEN');
    expect(text).toContain('process.env.API_EXPIRED_TOKEN');
    expect(text).toContain("test.skip(!credential,");
    expect(text).not.toContain('demo-suspended-token');
    const rules = idsIn(text).map((id) => (parseCaseId(id) as any).parts.rule);
    expect(rules).toEqual(expect.arrayContaining(['forbidden', 'expired-credentials']));
    const me = ts.r.coverage.find((c) => c.operation === 'GET /me')!;
    expect(me.uncheckedStatuses).toEqual([]);
  });

  it('a section that does not match the spec is reported, never used', async () => {
    expect(checkAuthConfig({ forbidden: { credentialEnv: 'lower', operations: ['nope'] } }, demoOps)).toEqual([
      'auth.forbidden.credentialEnv must name an environment variable (e.g. API_FORBIDDEN_TOKEN)',
      'auth.forbidden: operation "nope" is not in the spec',
    ]);
    const deps = { ...demoDeps, auth: { forbidden: { credentialEnv: 'API_FORBIDDEN_TOKEN', operations: ['getHealth'] } } };
    const ts = await gen(demo, demoOps, deps, 'typescript');
    const health = ts.r.coverage.find((c) => c.operation === 'GET /health')!;
    expect(health.gaps.map((g) => g.code)).toContain('INVALID_REVIEWED_CONFIG');
  });

  it('without a reviewed section 403 stays a gap that names the missing configuration', async () => {
    const { auth, ...withoutAuth } = ksDeps;
    void auth;
    const ts = await gen(ks, ksOps, withoutAuth, 'typescript');
    const orders = ts.r.coverage.find((c) => c.operation === 'GET /orders')!;
    expect(orders.gaps.find((g) => g.location === 'response.status#/403')?.reason).toContain('deps "auth.forbidden"');
  });
});

describe('gap codes say the actual reason', () => {
  it('a write without confirmed cleanup: every status has the success call\'s reason', async () => {
    const ts = await gen(demo, demoOps, demoDeps, 'typescript');
    const reset = ts.r.coverage.find((c) => c.operation === 'POST /admin/reset')!;
    expect(reset.uncheckedStatuses).toEqual([{ status: '204', code: 'MISSING_CLEANUP' }, { status: '401', code: 'MISSING_CLEANUP' }]);
    const report = ts.r.coverage.find((c) => c.operation === 'GET /reports/{reportId}')!;
    expect(report.uncheckedStatuses).toEqual([{ status: '200', code: 'MISSING_RESOURCE_SOURCE' }]);
  });
});

describe('CI quality gates', () => {
  it('a write test without guaranteed cleanup fails the gate (TypeScript and Python)', () => {
    const ts = [
      "import x;",
      "  test('creates and forgets', {}, async ({ api }) => {",
      '    const { id } = await resource.create(api);',
      '    const res = await api.items.getItem(id);',
      '    expect(res.status()).toBe(200);',
      '  });',
      "  test('creates and cleans', {}, async ({ api }) => {",
      '    const { id } = await resource.create(api);',
      '    try {',
      '      expect(1).toBe(1);',
      '    } finally {',
      '      await resource.remove(api, id);',
      '    }',
      '  });',
      "  test('asserts before cleanup', {}, async ({ api }) => {",
      '    const res = await api.items.createItem({ data: payload });',
      '    expect(res.status()).toBe(201);',
      '    await resource.removeIfCreated(api, res);',
      '  });',
    ].join('\n');
    expect(cleanupProblems(ts, 'typescript').map((p) => p.test)).toEqual(["'creates and forgets', {}, async ({ api }) => {", "'asserts before cleanup', {}, async ({ api }) => {"]);
    const py = [
      'import pytest',
      '@pytest.mark.positive',
      'def test_forgets(api, items):',
      '    rid, _ = items.create()',
      '    assert rid',
      '@pytest.mark.positive',
      'def test_asserts_first(api, items):',
      '    res = api.post("items", json=items.new_create_payload())',
      '    assert res.status_code == 201',
      '    items.remove_if_created(res)',
      '@pytest.mark.positive',
      'def test_fixture(api, items, created_items):',
      '    res = api.patch(f"items/{created_items}", json={})',
    ].join('\n');
    expect(cleanupProblems(py, 'python').map((p) => p.test)).toEqual(['def test_forgets(api, items):', 'def test_asserts_first(api, items):']);
  });

  it('a lost active case or an unexplained new gap fails until the baseline is updated', () => {
    const d = compareBaseline({ activeCaseIds: ['a', 'b'], gaps: ['G1'] }, { activeCaseIds: ['b', 'c'], gaps: ['G2'] });
    expect(d).toEqual({ lostCases: ['a'], newCases: ['c'], newGaps: ['G2'], closedGaps: ['G1'] });
  });
});

describe('CI quality gates: Python fixtures', () => {
  it('a test that reassigns its resource fixture fails the gate (its cleanup would hit the wrong object)', () => {
    const py = [
      '@pytest.mark.positive',
      'def test_shadow(api, items):',
      '    ids = []',
      '    try:',
      '        ids.append(items.create({})[0])',
      '        items, totals, _ = (1, 2, 3)',
      '    finally:',
      '        for rid in ids:',
      '            items.remove(rid)',
      '@pytest.mark.positive',
      'def test_fine(api, items):',
      '    ids = []',
      '    try:',
      '        ids.append(items.create({})[0])',
      '        listed, totals, _ = (1, 2, 3)',
      '        assert listed == 1',
      '    finally:',
      '        for rid in ids:',
      '            items.remove(rid)',
    ].join('\n');
    expect(cleanupProblems(py, 'python').map((p) => p.problem)).toEqual(['the fixture "items" is reassigned in the test, so its cleanup no longer applies']);
  });
});
