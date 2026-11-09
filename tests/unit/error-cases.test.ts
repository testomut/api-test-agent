import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { findPython, generate } from '../../src/generate/generate.js';
import { errorPlan } from '../../src/generate/error-cases.js';
import { operationUid, normalizeSpec } from '../../src/change/normalize.js';
import { validateRegistry } from '../../src/cases/validate.js';

/** Stage 6 (docs/SUPPORT_MATRIX.md): documented error responses. */

const spec = await loadSpec('tests/fixtures/coverage/kitchen-sink.yaml');
const ops = buildCatalog(spec.doc);
const op = (key: string) => ops.find((o) => o.key === key)!;
const deps = { scenarios: [{ create: 'createOrder', idFrom: '/id', param: 'orderId', read: 'getOrder', update: 'updateOrder', delete: 'deleteOrder', conflictOn: ['customer'] }] };

describe('stage 6: documented error responses', () => {
  it('plans only safe triggers; the rest are gaps with codes', () => {
    const list = errorPlan({ doc: spec.doc, op: op('GET /orders'), ops, reachable: true, hasUpdatePayload: false, firstWith405: false });
    expect(list.invalidCredentials).toEqual({ headers: { Authorization: 'Bearer api-agent-invalid-token' }, params: {} });
    expect(list.gaps.map((g) => `${g.code} ${g.location}`)).toEqual(['UNCONFIRMED_BUSINESS_RULE response.status#/403', 'UNSAFE_LIVE_CHECK response.status#/429']);

    const cancel = errorPlan({ doc: spec.doc, op: op('POST /orders/{orderId}/cancel'), ops, reachable: false, hasUpdatePayload: false, firstWith405: true });
    expect(cancel.methodNotAllowed).toEqual({ method: 'get' }); // the path defines no GET

    const create = errorPlan({ doc: spec.doc, op: op('POST /orders'), ops, reachable: true, hasUpdatePayload: false, firstWith405: false, role: 'create' });
    expect(create.unsupportedMediaType).toBe(true);
    expect(create.conflict).toBeUndefined(); // no conflictOn in a reviewed deps file
    expect(create.gaps).toContainEqual(expect.objectContaining({ code: 'UNCONFIRMED_BUSINESS_RULE', location: 'response.status#/409' }));

    const update = errorPlan({ doc: spec.doc, op: op('PUT /orders/{orderId}'), ops, reachable: true, hasUpdatePayload: true, firstWith405: false, role: 'update' });
    expect(update.preconditionFailed).toEqual({ header: 'If-Match', value: '"api-agent-no-such-etag"' });
    expect(update.gaps).toContainEqual(expect.objectContaining({ code: 'UNREACHABLE_RESPONSE_STATUS', location: 'response.status#/418' }));
  });

  it('405 is never sent as an unsafe method: a path with GET gets a gap', () => {
    const del = { ...op('DELETE /orders/{orderId}'), responses: [...op('DELETE /orders/{orderId}').responses, { status: '405', contentTypes: [], hasSchema: false }] };
    const r = errorPlan({ doc: spec.doc, op: del, ops, reachable: true, hasUpdatePayload: false, firstWith405: true });
    expect(r.methodNotAllowed).toBeUndefined();
    expect(r.gaps).toContainEqual(expect.objectContaining({ code: 'UNSAFE_LIVE_CHECK', location: 'response.status#/405' }));
  });

  it('generated suites: the same error cases in TypeScript and Python, each with its own ID; cleanup in finally', async () => {
    const out = async (lang: 'typescript' | 'python') => {
      const dir = await mkdtemp(join(tmpdir(), 'ata-err-'));
      const res = await generate(spec, ops, { outDir: dir, version: 'test', lang, deps });
      return { dir, res, reg: JSON.parse(await readFile(join(dir, '_support/cases.json'), 'utf8')), read: (f: string) => readFile(join(dir, f), 'utf8') };
    };
    const ts = await out('typescript');
    const py = await out('python');
    const list = operationUid('GET', '/orders');
    const put = operationUid('PUT', '/orders/{}');
    const post = operationUid('POST', '/orders');
    const cancel = operationUid('POST', '/orders/{}/cancel');
    for (const id of [
      `ata:${list}:functional:negative:request.security:invalid-credentials`,
      `ata:${cancel}:functional:negative:operation:method-not-allowed`,
      `ata:${put}:functional:negative:request.header#/if-match:precondition-failed`,
      `ata:${post}:contract:negative:request.content-type:content-type`,
      `ata:${put}:contract:negative:request.content-type:content-type`,
    ]) expect(ts.reg.cases[id], id).toBeDefined();
    const conflict = Object.entries<any>(ts.reg.cases).find(([, c]) => c.rule === 'business-rule' && c.polarity === 'negative' && ts.reg.scenarios[c.subjectUid]?.scenarioType === 'business');
    expect(conflict, 'conflict scenario').toBeDefined();
    expect(ts.reg.scenarios[conflict![1].subjectUid]).toMatchObject({ scenarioType: 'business', primaryOperationUid: post });
    const active = (reg: any) => Object.keys(reg.cases).filter((k) => !reg.cases[k].status).sort();
    expect(active(py.reg)).toEqual(active(ts.reg));
    expect(validateRegistry(await ts.read('_support/cases.json'), normalizeSpec(await readFile('tests/fixtures/coverage/kitchen-sink.yaml', 'utf8'), 'ks')).errors).toEqual([]);

    const scenario = await ts.read('orders/post/scenarios.spec.ts');
    expect(scenario).toMatch(/const first = await resource\.create\(api, payload\);[\s\S]*expectStatus\(res, \['409'\][\s\S]*finally \{\s*await resource\.removeIfCreated\(api, res\);[\s\S]*finally \{\s*await resource\.remove\(api, first\.id\);/);
    expect(await ts.read('orders/get/functional.spec.ts')).toContain(`"Authorization":"Bearer api-agent-invalid-token"`);
    const cancelFile = await ts.read('orders-cancel/post/functional.spec.ts');
    expect(cancelFile).toContain(`await request.get('orders/00000000-0000-4000-8000-000000000009/cancel')`);
    expect(cancelFile).toContain(`expectStatus(res, ['405']`);
    expect(cancelFile).not.toMatch(/request\.(post|put|patch|delete)\(/); // never an unsafe method
    const cov = ts.res.coverage.find((c) => c.operation === 'GET /orders')!;
    expect(cov.gaps.map((g) => g.code)).toEqual(expect.arrayContaining(['UNCONFIRMED_BUSINESS_RULE', 'UNSAFE_LIVE_CHECK']));

    const pyFiles = py.res.files.filter((f) => f.endsWith('.py'));
    const compiled = spawnSync(findPython(), ['-m', 'py_compile', ...pyFiles], { encoding: 'utf8' });
    if (!compiled.error) expect(compiled.status, compiled.stderr).toBe(0);
    expect(await py.read('orders/post/test_scenarios.py')).toContain('def test_second_create_with_the_same_fields_conflicts(api, orders):');
  });
});
