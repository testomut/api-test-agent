import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as addFormatsModule from 'ajv-formats';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { paramCasesDetailed, requiredRequest } from '../../src/generate/param-cases.js';
import { findPython, generate } from '../../src/generate/generate.js';
import { operationUid } from '../../src/change/normalize.js';
import { validateRegistry } from '../../src/cases/validate.js';
import { normalizeSpec } from '../../src/change/normalize.js';
import type { ParamInfo } from '../../src/types.js';

/** Stage 4 (docs/SUPPORT_MATRIX.md): query, header, cookie and path parameter cases. */

const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (ajv: any) => void;
const spec = await loadSpec('tests/fixtures/coverage/kitchen-sink.yaml');
const ops = buildCatalog(spec.doc);
const op = (key: string) => ops.find((o) => o.key === key)!;
const ajv = new Ajv2020({ allErrors: true, strict: false, coerceTypes: true });
addFormats(ajv);

/** The value each parameter has in a case's request (query object or string, headers, Cookie, path). */
function valueOf(p: ParamInfo, req: { params?: any; headers?: Record<string, string>; path?: Record<string, string> }): unknown {
  if (p.in === 'path') return req.path?.[p.name] ?? p.knownValue;
  if (p.in === 'header') return Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === p.name.toLowerCase())?.[1];
  if (p.in === 'cookie') return (req.headers?.Cookie ?? '').split('; ').find((c) => c.startsWith(`${p.name}=`))?.slice(p.name.length + 1);
  if (typeof req.params === 'string') {
    const all = new URLSearchParams(req.params).getAll(p.name);
    if (!all.length) return undefined;
    // form + explode: false → one comma-separated value
    return (p.schema as any)?.type === 'array' ? (p.explode === false ? all[0].split(',') : all) : all[0];
  }
  const v = req.params?.[p.name];
  return (p.schema as any)?.type === 'array' && v !== undefined && !Array.isArray(v) ? [v] : v;
}
const valid = (p: ParamInfo, v: unknown) => (v === undefined ? !p.required : ajv.validate(p.schema ?? {}, Array.isArray(v) ? v.map((x) => (/^-?\d+$/.test(String(x)) ? Number(x) : x)) : /^-?\d+(\.\d+)?$/.test(String(v)) && ['integer', 'number'].includes((p.schema as any)?.type) ? Number(v) : v));

describe('stage 4: parameter cases', () => {
  const list = op('GET /orders');
  const r = paramCasesDetailed(spec.doc, list, { allowPath: true, allowOthers: true });

  it('every request is valid except the one parameter under test, which breaks its rule', () => {
    expect(r.cases.length).toBeGreaterThan(10);
    for (const c of r.cases) {
      const t = c.target as { in: string; field: string; rule: string };
      for (const p of list.params) {
        const v = valueOf(p, c.request!);
        const isTarget = p.in === t.in && p.name === t.field;
        if (isTarget) expect(valid(p, v), `${c.title}: ${p.name}=${JSON.stringify(v)} should break ${t.rule}`).toBe(false);
        else expect(valid(p, v), `${c.title}: ${p.in} ${p.name}=${JSON.stringify(v)} should stay valid`).toBe(true);
      }
    }
  });

  it('covers query, header and cookie rules; arrays use the documented style', () => {
    const got = new Set(r.cases.map((c) => `${(c.target as any).in}.${(c.target as any).field}:${c.target!.rule}`));
    for (const want of ['query.status:enum', 'query.limit:type', 'query.limit:minimum', 'query.limit:maximum', 'query.code:pattern', 'query.since:format', 'query.tags:maxItems', 'query.ids:uniqueItems', 'header.X-Request-Id:required', 'header.X-Request-Id:format', 'cookie.session:minLength']) {
      expect(got, want).toContain(want);
    }
    const tags = r.cases.find((c) => c.source === 'query.tags.maxItems')!;
    expect(tags.request!.params).toBe('tags=a,b,a,b'); // form, explode: false
    const ids = r.cases.find((c) => c.source === 'query.ids.uniqueItems')!;
    expect(ids.request!.params).toBe('ids=1&ids=1'); // form, explode: true (default)
    expect(r.cases.find((c) => c.source === 'header.X-Request-Id.required')!.request!.headers).toBeUndefined();
    expect(r.cases.find((c) => c.source === 'cookie.session.minLength')!.request!.headers).toMatchObject({ Cookie: 'session=xxxxxxx' });
  });

  it('every case carries the required header with its documented value, except the case that removes it', () => {
    expect(requiredRequest(list).headers).toEqual({ 'X-Request-Id': '00000000-0000-4000-8000-000000000001' });
    for (const c of r.cases.filter((x) => x.source !== 'header.X-Request-Id.required' && !x.source.startsWith('header.'))) expect(c.request!.headers?.['X-Request-Id'], c.title).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('path parameters: invalid format only; an out-of-range id on a write operation is a gap, not a request', () => {
    const get = paramCasesDetailed(spec.doc, op('GET /orders/{orderId}'), { allowPath: true, allowOthers: false });
    expect(get.cases.map((c) => [c.source, c.request!.path])).toEqual([['path.orderId.format', { orderId: 'not-a-uuid' }]]);
    const numeric = { ...op('DELETE /orders/{orderId}'), params: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: 999 }, knownValue: 5 }] } as any;
    const del = paramCasesDetailed(spec.doc, numeric, { allowPath: true, allowOthers: true });
    expect(del.cases.map((c) => c.source)).toEqual(['path.orderId.type']);
    expect(del.gaps.filter((g) => g.code === 'UNSAFE_LIVE_CHECK').map((g) => g.rule)).toEqual(['minimum', 'maximum']);
  });

  it('a required parameter without a documented value: no cases, a gap', () => {
    const missing = { ...list, params: [...list.params, { name: 'tenant', in: 'header', required: true, schema: { type: 'string' } }] } as any;
    const m = paramCasesDetailed(spec.doc, missing, { allowPath: true, allowOthers: true });
    expect(m.cases).toEqual([]);
    expect(m.gaps).toEqual([expect.objectContaining({ code: 'MISSING_VALID_SAMPLE', location: 'request.header#/tenant' })]);
  });

  it('generated suites: TypeScript and Python carry the same parameter cases; positive calls send the required header', async () => {
    const out = async (lang: 'typescript' | 'python') => {
      const dir = await mkdtemp(join(tmpdir(), 'ata-pc-'));
      await generate(spec, ops, { outDir: dir, version: 'test', lang });
      return { dir, reg: JSON.parse(await readFile(join(dir, '_support/cases.json'), 'utf8')), read: (f: string) => readFile(join(dir, f), 'utf8') };
    };
    const ts = await out('typescript');
    const py = await out('python');
    const uid = operationUid('GET', '/orders');
    for (const loc of ['request.header#/x-request-id:required', 'request.cookie#/session:minLength', 'request.query#/tags:maxItems']) expect(ts.reg.cases[`ata:${uid}:contract:negative:${loc}`], loc).toBeDefined();
    expect(ts.reg.cases[`ata:${operationUid('GET', '/orders/{}')}:contract:negative:request.path#/orderId:format`]).toBeDefined();
    const active = (reg: any) => Object.keys(reg.cases).filter((k) => !reg.cases[k].status).sort();
    expect(active(py.reg)).toEqual(active(ts.reg));
    expect(validateRegistry(await ts.read('_support/cases.json'), normalizeSpec(await readFile('tests/fixtures/coverage/kitchen-sink.yaml', 'utf8'), 'ks')).errors).toEqual([]);
    const tsList = await ts.read('orders/get/functional.spec.ts');
    expect(tsList).toContain(`headers: {"X-Request-Id":"00000000-0000-4000-8000-000000000001"}`);
    const pyContract = await py.read('orders/get/test_contract.py');
    expect(pyContract).toContain('def test_rejects_invalid_parameter(api, contract, parts):');
    expect(await py.read('orders/get/test_functional.py')).toContain('headers={');
    const compiled = spawnSync(findPython(), ['-m', 'py_compile', join(py.dir, 'orders/get/test_contract.py'), join(py.dir, 'orders/get_by_id/test_contract.py')], { encoding: 'utf8' });
    if (!compiled.error) expect(compiled.status, compiled.stderr).toBe(0);
  });
});
