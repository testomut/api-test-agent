import { describe, expect, it } from 'vitest';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as addFormatsModule from 'ajv-formats';
import { parse } from 'yaml';
import { bodyCasesDetailed } from '../../src/generate/body-cases.js';
import { sampleFromSchema } from '../../src/generate/sample.js';
import { generate, findPython } from '../../src/generate/generate.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { loadSpec } from '../../src/spec/loader.js';
import { ARRAY, bodyPointer, parseCaseId } from '../../src/cases/ids.js';
import { operationUid } from '../../src/change/normalize.js';

const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (ajv: any) => void;
const doc = parse(await readFile('tests/fixtures/coverage/kitchen-sink.yaml', 'utf8'));
const schemaRef = { $ref: '#/components/schemas/OrderInput' };
const sample = sampleFromSchema(doc, schemaRef);
if (!sample.ok) throw new Error(sample.reason);
const base = sample.value as Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema({ ...doc, $id: 'doc' });
const validate = ajv.compile({ $ref: 'doc#/components/schemas/OrderInput' });

/** The instance path ajv reports for a rule at a case path (array elements are index 0). */
const instancePath = (path: (string | typeof ARRAY)[]) => path.map((p) => '/' + (p === ARRAY ? '0' : String(p).replace(/~/g, '~0').replace(/\//g, '~1'))).join('');

describe('stage 3: recursive request-body cases', () => {
  const r = bodyCasesDetailed(doc, schemaRef, base, 'OrderInput', 500);

  it('the sampled base payload is valid', () => {
    expect(validate(base), JSON.stringify(validate.errors)).toBe(true);
  });

  it('every case breaks exactly one rule: one ajv error, the expected keyword, at the expected place', () => {
    expect(r.cases.length).toBeGreaterThan(30);
    for (const c of r.cases) {
      const t = c.target as { in: 'body'; path: (string | typeof ARRAY)[]; rule: string };
      expect(validate(c.data), `${c.title} should be invalid`).toBe(false);
      const errors = validate.errors ?? [];
      expect(errors.length, `${c.title}: ${JSON.stringify(errors)}`).toBe(1);
      const e = errors[0];
      const keyword = t.rule === 'nullable' ? 'type' : t.rule;
      expect(e.keyword, c.title).toBe(keyword);
      if (t.rule === 'required') {
        expect(e.instancePath, c.title).toBe(instancePath(t.path.slice(0, -1)));
        expect(e.params.missingProperty, c.title).toBe(t.path[t.path.length - 1]);
      } else expect(e.instancePath, c.title).toBe(instancePath(t.path));
    }
  });

  it('covers nested objects, array items and every supported keyword', () => {
    const got = new Set(r.cases.map((c) => `${bodyPointer((c.target as any).path)}:${c.target!.rule}`));
    for (const want of [
      '/customer:type', '/customer/name:required', '/customer/name:minLength', '/customer/name:maxLength', '/customer/name:nullable',
      '/customer/email:format', '/customer/code:pattern', '/customer/address:maxProperties', '/customer/address/city:maxLength',
      '/items:minItems', '/items:uniqueItems', '/items/*/sku:required', '/items/*/qty:minimum', '/items/*/qty:maximum',
      '/items/*/price:exclusiveMinimum', '/items/*/price:exclusiveMaximum', '/items/*/price:multipleOf',
      '/total:minimum', '/status:enum', '/priority:enum', '/gift:enum', '/kind:const', '/tags/*:maxLength', '/tags:maxItems',
      '/meta:minProperties', ':additionalProperties',
    ]) expect(got, want).toContain(want);
    expect(got).not.toContain('/comment:nullable'); // null is allowed there
  });

  it('cannot-isolate and unsupported rules are coverage gaps with code and exact location', () => {
    const gaps = r.gaps.map((g) => `${g.code} ${g.location} ${g.rule ?? ''}`.trim());
    expect(gaps).toContain('UNSUPPORTED_SCHEMA_KEYWORD request.body#/payment oneOf');
    expect(gaps).toContain('CANNOT_ISOLATE_RULE request.body#/items maxItems'); // repeating would break uniqueItems
    expect(gaps).toContain('CANNOT_ISOLATE_RULE request.body#/status type'); // the enum case covers it
  });

  it('the case limit is reported, not silent', () => {
    const limited = bodyCasesDetailed(doc, schemaRef, base, 'OrderInput', 5);
    expect(limited.cases).toHaveLength(5);
    expect(limited.potential).toBe(r.cases.length);
    expect(limited.dropped).toHaveLength(r.cases.length - 5);
    expect(limited.gaps.filter((g) => g.code === 'CASE_LIMIT_REACHED')).toHaveLength(r.cases.length - 5);
  });

  it('generated suites: nested pointers in case IDs, same cases in TypeScript and Python, gaps in coverage', async () => {
    const spec = await loadSpec('tests/fixtures/coverage/kitchen-sink.yaml');
    const ops = buildCatalog(spec.doc);
    const out = async (lang: 'typescript' | 'python') => {
      const dir = await mkdtemp(join(tmpdir(), 'ata-ks-'));
      const res = await generate(spec, ops, { outDir: dir, version: 'test', lang, maxCases: 500 });
      return { dir, res, reg: JSON.parse(await readFile(join(dir, '_support/cases.json'), 'utf8')) };
    };
    const ts = await out('typescript');
    const py = await out('python');
    const uid = operationUid('POST', '/orders');
    expect(ts.reg.cases[`ata:${uid}:contract:negative:request.body#/items/*/price:multipleOf`]).toBeDefined();
    expect(ts.reg.cases[`ata:${uid}:contract:negative:request.body#/customer/address/city:maxLength`]).toBeDefined();
    for (const id of Object.keys(ts.reg.cases)) expect(parseCaseId(id).ok, id).toBe(true);
    const active = (reg: any) => Object.keys(reg.cases).filter((k) => !reg.cases[k].status).sort();
    expect(active(py.reg)).toEqual(active(ts.reg));
    const cov = ts.res.coverage.find((c) => c.operation === 'POST /orders')!;
    expect(cov.bodyCases).toEqual({ potential: r.cases.length, generated: r.cases.length, dropped: 0 });
    expect(cov.gaps.some((g) => g.code === 'UNSUPPORTED_SCHEMA_KEYWORD' && g.location === 'request.body#/payment')).toBe(true);
    const pyFile = join(py.dir, 'orders/post/test_contract.py');
    const compiled = spawnSync(findPython(), ['-m', 'py_compile', pyFile], { encoding: 'utf8' });
    if (!compiled.error) expect(compiled.status, compiled.stderr).toBe(0);
  });
});
