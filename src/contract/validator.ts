/**
 * Response contract validator.
 *
 * This file is deliberately self-contained (no imports from the agent): `generate`
 * copies it verbatim into tests/generated/_support/ so generated tests run without
 * the agent installed. Keep it dependency-light: ajv + ajv-formats only.
 * src/contract/contract.py is its Python twin: keep the rules identical.
 */
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (ajv: any) => void;

export type ContractProblemKind = 'undocumented-status' | 'content-type' | 'schema' | 'unparseable-body' | 'empty-body' | 'unexpected-body' | 'header';

export interface ContractResult {
  ok: boolean;
  /** true when the spec gave something to validate the body against */
  bodyChecked: boolean;
  kind?: ContractProblemKind;
  errors: string[];
  matchedStatus?: string;
  /** What was not checked and why (e.g. a media type without a supported schema). Never a failure. */
  notes?: string[];
}

export interface ResponseInput {
  method: string;
  path: string;
  status: number;
  contentType?: string | null;
  /** Parsed JSON for JSON media types, the text otherwise; undefined when JSON could not be parsed. */
  body: unknown;
  /** The raw response text: decides "empty" and "unexpected body". */
  rawText?: string;
  /** Response headers (any case). */
  headers?: Record<string, string>;
}

const DOC_ID = 'openapi.json';
/** Statuses that never carry a body (RFC 9110). */
const NO_BODY_STATUS = new Set([204, 205, 304]);

export class ContractValidator {
  private readonly ajv: Ajv;
  private readonly cache = new Map<string, ValidateFunction>();
  private readonly doc: any;

  constructor(doc: any) {
    const is31 = /^3\.[12]\./.test(String(doc.openapi ?? '')); // 3.1 and 3.2: JSON Schema 2020-12
    const copy = structuredClone(doc);
    // Responses only: a writeOnly property is never sent back, so it is never required in a response.
    dropWriteOnlyFromRequired(copy);
    this.doc = is31 ? copy : nullableToJsonSchema(copy);
    const opts = { strict: false, allErrors: true, validateSchema: false } as const;
    this.ajv = (is31 ? new Ajv2020(opts) : new Ajv(opts)) as Ajv;
    addFormats(this.ajv);
    // writeOnly properties must not appear in a response.
    this.ajv.removeKeyword('writeOnly'); // ajv knows it as an annotation; redefine it as a check
    this.ajv.addKeyword({ keyword: 'writeOnly', schemaType: 'boolean', validate: (writeOnly: boolean) => !writeOnly, errors: false });
    this.ajv.addSchema(this.doc, DOC_ID);
  }

  private compile(pointer: string): ValidateFunction {
    let validate = this.cache.get(pointer);
    if (!validate) {
      validate = this.ajv.compile({ $ref: `${DOC_ID}#${pointer}` });
      this.cache.set(pointer, validate);
    }
    return validate;
  }

  private messages(validate: ValidateFunction, prefix = ''): string[] {
    return (validate.errors ?? []).map((e) => `${prefix}${e.instancePath || '(root)'} ${e.keyword === 'writeOnly' ? 'is writeOnly and must not appear in a response' : e.message}`);
  }

  validateResponse(input: ResponseInput): ContractResult {
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
    const notes: string[] = [];

    // Response headers: required ones present, every documented one matching its schema.
    const headerErrors = this.checkHeaders(resp.node?.headers ?? {}, `${resp.pointer}/headers`, input.headers);
    if (headerErrors.length) return { ok: false, bodyChecked: false, kind: 'header', matchedStatus: matched, errors: headerErrors };

    // Without the raw text, the parsed body stands for it (JSON null is the text "null", not an empty body).
    const raw = input.rawText ?? (typeof input.body === 'string' ? input.body : input.body === undefined ? '' : JSON.stringify(input.body));
    const content = resp.node?.content;
    const head = input.method.toLowerCase() === 'head';
    // 204 / 205 / 304 and HEAD never carry a body (RFC 9110): one that arrives breaks the contract.
    if (NO_BODY_STATUS.has(input.status) || head) {
      if (raw.trim().length && !head) {
        return { ok: false, bodyChecked: true, kind: 'unexpected-body', matchedStatus: matched, errors: [`A body was returned but status ${code} has no body (${raw.length} bytes)`] };
      }
      return { ok: true, bodyChecked: false, errors: [], matchedStatus: matched };
    }
    // No content documented means "not described", not "no body": the body is not checked, and that is said.
    if (!content || !Object.keys(content).length) {
      if (raw.trim().length) notes.push(`${matched}: no content documented, body not checked (${raw.length} bytes)`);
      return { ok: true, bodyChecked: false, errors: [], matchedStatus: matched, ...(notes.length ? { notes } : {}) };
    }

    const actual = (input.contentType ?? '').split(';')[0].trim().toLowerCase();
    const mediaKey = pickMedia(Object.keys(content), actual);
    // A declared but undocumented Content-Type is the more precise problem; an empty body comes next.
    if (!raw.trim().length && (!actual || mediaKey)) {
      const hasSchema = Object.values<any>(content).some((m) => m?.schema);
      if (hasSchema) return { ok: false, bodyChecked: true, kind: 'empty-body', matchedStatus: matched, errors: [`The body is empty but ${matched} documents ${Object.keys(content).join(', ')}`] };
      return { ok: true, bodyChecked: false, errors: [], matchedStatus: matched };
    }
    if (!mediaKey) {
      return {
        ok: false,
        bodyChecked: false,
        kind: 'content-type',
        matchedStatus: matched,
        errors: [`Content-Type "${actual || 'none'}" is not documented for ${matched} (documented: ${Object.keys(content).join(', ')})`],
      };
    }
    const schemaPtr = `${resp.pointer}/content/${esc(mediaKey)}/schema`;
    if (!content[mediaKey]?.schema) {
      return { ok: true, bodyChecked: false, errors: [], matchedStatus: matched, notes: [`${matched} ${mediaKey}: no schema documented, body not checked`] };
    }
    if (baseMedia(mediaKey).startsWith('text/')) {
      // Text bodies with a schema: the text is the (string) instance.
      const validate = this.compile(schemaPtr);
      const ok = validate(raw) as boolean;
      return { ok, bodyChecked: true, kind: ok ? undefined : 'schema', matchedStatus: matched, errors: ok ? [] : this.messages(validate) };
    }
    if (!baseMedia(mediaKey).includes('json')) {
      return { ok: true, bodyChecked: false, errors: [], matchedStatus: matched, notes: [`${matched} ${mediaKey}: media type not supported by the validator, body not checked`] };
    }
    if (input.body === undefined) {
      return { ok: false, bodyChecked: true, kind: 'unparseable-body', matchedStatus: matched, errors: ['Body is not valid JSON'] };
    }
    const validate = this.compile(schemaPtr);
    const ok = validate(input.body) as boolean;
    return { ok, bodyChecked: true, kind: ok ? undefined : 'schema', matchedStatus: matched, errors: ok ? [] : this.messages(validate) };
  }

  private checkHeaders(defs: Record<string, any>, pointer: string, actual?: Record<string, string>): string[] {
    const errors: string[] = [];
    const got = Object.fromEntries(Object.entries(actual ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    for (const [name, raw] of Object.entries<any>(defs)) {
      if (name.toLowerCase() === 'content-type') continue; // OpenAPI: ignored, the media type decides
      const def = raw?.$ref ? resolve(this.doc, raw.$ref.slice(1)).node : raw;
      const value = got[name.toLowerCase()];
      if (value === undefined) {
        if (def?.required) errors.push(`Required response header "${name}" is missing`);
        continue;
      }
      if (!def?.schema || actual === undefined) continue;
      const validate = this.compile(`${pointer}/${esc(name)}/schema`);
      if (!(validate(headerValue(def.schema, value, this.doc)) as boolean)) errors.push(...this.messages(validate, `header "${name}" `));
    }
    return errors;
  }
}

/** A header value as its schema expects it: numbers, booleans and comma-separated arrays (style: simple). */
function headerValue(schemaRaw: any, value: string, doc: any): unknown {
  const schema = schemaRaw?.$ref ? resolve(doc, schemaRaw.$ref.slice(1)).node : schemaRaw;
  const types: string[] = schema?.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const scalar = (v: string, t: string[]) => {
    if ((t.includes('integer') || t.includes('number')) && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
    if (t.includes('boolean') && (v === 'true' || v === 'false')) return v === 'true';
    return v;
  };
  if (types.includes('array')) {
    const items = schema.items?.$ref ? resolve(doc, schema.items.$ref.slice(1)).node : schema.items;
    const it: string[] = items?.type === undefined ? [] : Array.isArray(items.type) ? items.type : [items.type];
    return value.split(',').map((v) => scalar(v.trim(), it));
  }
  return scalar(value, types);
}

/** Removes writeOnly properties from every `required` list (they are never part of a response). */
function dropWriteOnlyFromRequired(node: any, seen = new Set<any>()): void {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) return node.forEach((n) => dropWriteOnlyFromRequired(n, seen));
  if (Array.isArray(node.required) && node.properties && typeof node.properties === 'object') {
    node.required = node.required.filter((name: string) => node.properties[name]?.writeOnly !== true);
  }
  for (const v of Object.values(node)) dropWriteOnlyFromRequired(v, seen);
}

/** Media types are compared without parameters: "application/json; v=1.0" documents "application/json". */
const baseMedia = (m: string) => m.split(';')[0].trim().toLowerCase();

function pickMedia(keys: string[], actual: string): string | undefined {
  const exact = keys.find((k) => baseMedia(k) === actual);
  if (exact) return exact;
  const [type] = actual.split('/');
  return keys.find((k) => baseMedia(k) === `${type}/*`) ?? keys.find((k) => baseMedia(k) === '*/*');
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
