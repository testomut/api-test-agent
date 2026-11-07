/**
 * Response contract validator.
 *
 * This file is deliberately self-contained (no imports from the agent): `generate`
 * copies it verbatim into tests/generated/_support/ so generated tests run without
 * the agent installed. Keep it dependency-light: ajv + ajv-formats only.
 */
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (ajv: any) => void;

export type ContractProblemKind = 'undocumented-status' | 'content-type' | 'schema' | 'unparseable-body';

export interface ContractResult {
  ok: boolean;
  /** true when the spec gave something to validate the body against */
  bodyChecked: boolean;
  kind?: ContractProblemKind;
  errors: string[];
  matchedStatus?: string;
}

const DOC_ID = 'openapi.json';

export class ContractValidator {
  private readonly ajv: Ajv;
  private readonly cache = new Map<string, ValidateFunction>();
  private readonly doc: any;

  constructor(doc: any) {
    const is31 = String(doc.openapi ?? '').startsWith('3.1');
    this.doc = is31 ? structuredClone(doc) : nullableToJsonSchema(structuredClone(doc));
    const opts = { strict: false, allErrors: true, validateSchema: false } as const;
    this.ajv = (is31 ? new Ajv2020(opts) : new Ajv(opts)) as Ajv;
    addFormats(this.ajv);
    this.ajv.addSchema(this.doc, DOC_ID);
  }

  validateResponse(input: { method: string; path: string; status: number; contentType?: string | null; body: unknown }): ContractResult {
    const opPtr = `/paths/${esc(input.path)}/${input.method.toLowerCase()}`;
    const responses = resolve(this.doc, `${opPtr}/responses`).node ?? {};
    const code = String(input.status);
    const matched = [code, `${code[0]}XX`, `${code[0]}xx`, 'default'].find((k) => k in responses);
    if (!matched) {
      return {
        ok: false,
        bodyChecked: false,
        kind: 'undocumented-status',
        errors: [`Status ${code} is not documented (documented: ${Object.keys(responses).join(', ') || 'none'})`],
      };
    }
    const resp = resolve(this.doc, `${opPtr}/responses/${esc(matched)}`);
    const content = resp.node?.content;
    if (!content || !Object.keys(content).length) return { ok: true, bodyChecked: false, errors: [], matchedStatus: matched };

    const actual = (input.contentType ?? '').split(';')[0].trim().toLowerCase();
    const mediaKey = pickMedia(Object.keys(content), actual);
    if (!mediaKey) {
      return {
        ok: false,
        bodyChecked: false,
        kind: 'content-type',
        matchedStatus: matched,
        errors: [`Content-Type "${actual || 'none'}" is not documented for ${matched} (documented: ${Object.keys(content).join(', ')})`],
      };
    }
    if (!content[mediaKey]?.schema || !mediaKey.includes('json')) {
      return { ok: true, bodyChecked: false, errors: [], matchedStatus: matched };
    }
    if (input.body === undefined) {
      return { ok: false, bodyChecked: true, kind: 'unparseable-body', matchedStatus: matched, errors: ['Body is not valid JSON'] };
    }

    const schemaPtr = `${resp.pointer}/content/${esc(mediaKey)}/schema`;
    let validate = this.cache.get(schemaPtr);
    if (!validate) {
      validate = this.ajv.compile({ $ref: `${DOC_ID}#${schemaPtr}` });
      this.cache.set(schemaPtr, validate);
    }
    const ok = validate(input.body) as boolean;
    return {
      ok,
      bodyChecked: true,
      kind: ok ? undefined : 'schema',
      matchedStatus: matched,
      errors: ok ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`),
    };
  }
}

function pickMedia(keys: string[], actual: string): string | undefined {
  const exact = keys.find((k) => k.toLowerCase() === actual);
  if (exact) return exact;
  const [type] = actual.split('/');
  return keys.find((k) => k === `${type}/*`) ?? keys.find((k) => k === '*/*');
}

function esc(part: string): string {
  return part.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Resolve a JSON pointer, following whole-object local $refs. */
function resolve(doc: any, pointer: string, depth = 0): { node: any; pointer: string } {
  let node: any = doc;
  let current = '';
  for (const raw of pointer.split('/').slice(1)) {
    if (node?.$ref && depth < 20) ({ node, pointer: current } = resolve(doc, node.$ref.slice(1), depth + 1));
    if (node == null) return { node: undefined, pointer: current };
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = node[part];
    current += '/' + esc(part);
  }
  if (node?.$ref && depth < 20) return resolve(doc, node.$ref.slice(1), depth + 1);
  return { node, pointer: current };
}

/** OpenAPI 3.0 `nullable: true` → JSON Schema `type: [T, "null"]`. */
function nullableToJsonSchema(node: any): any {
  if (Array.isArray(node)) return node.map(nullableToJsonSchema);
  if (!node || typeof node !== 'object') return node;
  for (const k of Object.keys(node)) node[k] = nullableToJsonSchema(node[k]);
  if (node.nullable === true) {
    if (typeof node.type === 'string') node.type = [node.type, 'null'];
    if (Array.isArray(node.enum) && !node.enum.includes(null)) node.enum = [...node.enum, null];
    if (!node.type && !node.enum && (node.allOf || node.oneOf || node.anyOf || node.$ref)) {
      const { nullable, ...rest } = node;
      return { anyOf: [rest, { type: 'null' }] };
    }
    delete node.nullable;
  }
  return node;
}
