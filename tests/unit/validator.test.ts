import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ContractValidator, type ResponseInput } from '../../src/contract/validator.js';
import { findPython } from '../../src/generate/generate.js';

/** Stage 5 (docs/SUPPORT_MATRIX.md): response contract rules, identical in validator.ts and contract.py. */

const doc = {
  openapi: '3.1.0',
  info: { title: 'v', version: '1' },
  paths: {
    '/users': {
      get: {
        responses: {
          '200': {
            description: 'ok',
            headers: {
              'X-Total-Count': { required: true, schema: { type: 'integer', minimum: 0 } },
              'X-Flags': { schema: { type: 'array', items: { type: 'boolean' } } },
              'Content-Type': { required: true, schema: { type: 'string' } },
            },
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
          default: { description: 'error', content: { 'application/json': { schema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } } } } },
        },
      },
      delete: { responses: { '204': { description: 'gone' }, '4XX': { description: 'client error' } } },
      head: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } } },
    },
    '/text': { get: { responses: { '200': { description: 'ok', content: { 'text/plain': { schema: { type: 'string', pattern: '^OK' } } } } } } },
    '/xml': { get: { responses: { '200': { description: 'ok', content: { 'application/xml': { schema: { type: 'object' } } } } } } },
    '/free': { get: { responses: { '200': { description: 'ok', content: { 'application/json': {} } } } } },
  },
  components: {
    schemas: {
      User: {
        type: 'object',
        required: ['id', 'password'],
        properties: { id: { type: 'string', format: 'uuid' }, password: { type: 'string', writeOnly: true }, nickname: { type: ['string', 'null'] } },
      },
    },
  },
};

const user = { id: '00000000-0000-4000-8000-000000000001', nickname: null };
const json = (body: unknown) => ({ contentType: 'application/json', body, rawText: JSON.stringify(body) });
const okHeaders = { 'x-total-count': '3', 'content-type': 'application/json' };

/** [name, input, expected ok, expected kind] */
const CASES: [string, ResponseInput, boolean, string | undefined][] = [
  ['valid body and headers', { method: 'get', path: '/users', status: 200, ...json(user), headers: okHeaders }, true, undefined],
  ['writeOnly property not required in a response', { method: 'get', path: '/users', status: 200, ...json(user), headers: okHeaders }, true, undefined],
  ['writeOnly property present in a response', { method: 'get', path: '/users', status: 200, ...json({ ...user, password: 'x' }), headers: okHeaders }, false, 'schema'],
  ['format checked', { method: 'get', path: '/users', status: 200, ...json({ id: 'nope' }), headers: okHeaders }, false, 'schema'],
  ['required response header missing', { method: 'get', path: '/users', status: 200, ...json(user), headers: { 'content-type': 'application/json' } }, false, 'header'],
  ['header schema (integer, minimum)', { method: 'get', path: '/users', status: 200, ...json(user), headers: { ...okHeaders, 'x-total-count': '-1' } }, false, 'header'],
  ['header array of booleans (style simple)', { method: 'get', path: '/users', status: 200, ...json(user), headers: { ...okHeaders, 'x-flags': 'true,false' } }, true, undefined],
  ['header array with a bad item', { method: 'get', path: '/users', status: 200, ...json(user), headers: { ...okHeaders, 'x-flags': 'true,maybe' } }, false, 'header'],
  ['default response matches its schema', { method: 'get', path: '/users', status: 503, ...json({ message: 'down' }) }, true, undefined],
  ['default response breaks its schema', { method: 'get', path: '/users', status: 503, ...json({}) }, false, 'schema'],
  ['empty body where a schema is documented', { method: 'get', path: '/users', status: 200, contentType: 'application/json', body: null, rawText: '', headers: okHeaders }, false, 'empty-body'],
  ['204 without a body', { method: 'delete', path: '/users', status: 204, contentType: null, body: '', rawText: '' }, true, undefined],
  ['204 with a body', { method: 'delete', path: '/users', status: 204, ...json({ deleted: true }) }, false, 'unexpected-body'],
  ['4XX range without content, body returned', { method: 'delete', path: '/users', status: 409, ...json({ message: 'conflict' }) }, false, 'unexpected-body'],
  ['HEAD: no body is expected', { method: 'head', path: '/users', status: 200, contentType: 'application/json', body: '', rawText: '' }, true, undefined],
  ['text/plain matches its string schema', { method: 'get', path: '/text', status: 200, contentType: 'text/plain', body: 'OK fine', rawText: 'OK fine' }, true, undefined],
  ['text/plain breaks its pattern', { method: 'get', path: '/text', status: 200, contentType: 'text/plain', body: 'bad', rawText: 'bad' }, false, 'schema'],
  ['undocumented content type', { method: 'get', path: '/text', status: 200, contentType: 'application/json', body: {}, rawText: '{}' }, false, 'content-type'],
  ['undocumented status', { method: 'get', path: '/text', status: 500, contentType: 'text/plain', body: 'x', rawText: 'x' }, false, 'undocumented-status'],
  ['unparseable JSON', { method: 'get', path: '/users', status: 200, contentType: 'application/json', body: undefined, rawText: '{oops', headers: okHeaders }, false, 'unparseable-body'],
  ['empty body with an undocumented Content-Type: the type is the problem', { method: 'get', path: '/users', status: 200, contentType: 'text/html', body: '', rawText: '', headers: okHeaders }, false, 'content-type'],
  ['JSON null without raw text is a body, not an empty one', { method: 'get', path: '/users', status: 200, contentType: 'application/json', body: null, headers: okHeaders }, false, 'schema'],
  ['xml: not checked, with a note', { method: 'get', path: '/xml', status: 200, contentType: 'application/xml', body: '<a/>', rawText: '<a/>' }, true, undefined],
  ['json without a schema: not checked, with a note', { method: 'get', path: '/free', status: 200, ...json({ any: 1 }) }, true, undefined],
];

describe('stage 5: response contract', () => {
  const v = new ContractValidator(doc);

  for (const [name, input, ok, kind] of CASES) {
    it(`TypeScript: ${name}`, () => {
      const r = v.validateResponse(input);
      expect({ ok: r.ok, kind: r.kind }, r.errors.join('; ')).toEqual({ ok, kind });
    });
  }

  it('notes say what was not checked', () => {
    expect(v.validateResponse(CASES.find((c) => c[0].startsWith('xml'))![1]).notes).toEqual(['200 application/xml: media type not supported by the validator, body not checked']);
    expect(v.validateResponse(CASES.find((c) => c[0].startsWith('json without'))![1]).notes).toEqual(['200 application/json: no schema documented, body not checked']);
  });

  it('Python (contract.py) gives the same result for every case', async () => {
    const python = findPython();
    if (spawnSync(python, ['-c', 'import jsonschema'], { encoding: 'utf8' }).status !== 0) return; // no jsonschema here: CI runs it
    const dir = await mkdtemp(join(tmpdir(), 'ata-val-'));
    await writeFile(join(dir, 'doc.json'), JSON.stringify(doc));
    await writeFile(join(dir, 'cases.json'), JSON.stringify(CASES.map(([name, i]) => ({ name, ...i, body: i.body === undefined ? '__UNPARSEABLE__' : i.body }))));
    const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(resolve('src/contract'))})
import contract
v = contract.ContractValidator(json.load(open(${JSON.stringify(join(dir, 'doc.json'))})))
out = []
for c in json.load(open(${JSON.stringify(join(dir, 'cases.json'))})):
    body = contract._UNPARSEABLE if c["body"] == "__UNPARSEABLE__" else c["body"]
    ok, kind, errors = v.validate(c["method"], c["path"], c["status"], c.get("contentType"), body, c.get("rawText"), c.get("headers"))
    out.append({"name": c["name"], "ok": ok, "kind": kind})
print(json.dumps(out))
`;
    const r = spawnSync(python, ['-I', '-c', script], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const py = JSON.parse(r.stdout);
    expect(py).toEqual(CASES.map(([name, , ok, kind]) => ({ name, ok, kind: kind ?? null })));
  });
});
