import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { resolvePointer, type OpenApiDoc } from '../spec/loader.js';
import { nullableToJsonSchema } from '../contract/validator.js';
import { ARRAY, bodyPointer } from '../cases/ids.js';
import { sampleFromSchema } from './sample.js';
import type { CoverageGap, PathSeg } from './body-cases.js';

/**
 * Positive request-body variants (docs/SUPPORT_MATRIX.md, "Request body: positive variants"). Each one is a valid
 * payload that differs from the documented example in one documented way, so it can expose an API that accepts
 * only the example's shape:
 *   - optional-omitted: only the required fields (optional ones removed wherever the schema allows it);
 *   - variant: another branch of a oneOf / anyOf, with a sample built from that branch.
 * Every variant is checked against the request schema with ajv before a test is written; one that is not valid is
 * a gap with the reason, never a test that would fail for the wrong reason.
 */

export interface BodyVariant {
  kind: 'optional-omitted' | 'variant';
  /** Case location: request.body# or request.body#<pointer>/@<branch>. */
  location: string;
  title: string;
  /** Runtime transformation of the fresh payload: JSON pointers (array element 0 for "*") to remove, or one value to set. */
  remove?: string[];
  set?: { pointer: string; value: unknown };
}

const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (ajv: any) => void;
const DOC_ID = 'request.json';
const cache = new WeakMap<object, { ajv: Ajv }>();

/** ajv over the spec for REQUEST bodies (readOnly / writeOnly are annotations here, not checks). */
function requestAjv(doc: OpenApiDoc): Ajv {
  let entry = cache.get(doc as object);
  if (!entry) {
    const is31 = /^3\.[12]\./.test(String((doc as any).openapi ?? ''));
    const copy = structuredClone(doc);
    const opts = { strict: false, allErrors: true, validateSchema: false } as const;
    const ajv = (is31 ? new Ajv2020(opts) : new Ajv(opts)) as Ajv;
    addFormats(ajv);
    ajv.addSchema(is31 ? copy : nullableToJsonSchema(copy), DOC_ID);
    entry = { ajv };
    cache.set(doc as object, entry);
  }
  return entry.ajv;
}

/** A validator for the request schema at `schemaPointer` (an operation's requestBody JSON schema). */
export function requestValidator(doc: OpenApiDoc, schemaPointer: string): ValidateFunction {
  return requestAjv(doc).compile({ $ref: `${DOC_ID}#${schemaPointer}` });
}

/** A validator for an inline schema of the spec (a oneOf / anyOf branch): its local $refs point into the spec. */
function inlineValidator(doc: OpenApiDoc, schema: any): ValidateFunction {
  const is31 = /^3\.[12]\./.test(String((doc as any).openapi ?? ''));
  const rewrite = (n: any): any => {
    if (Array.isArray(n)) return n.map(rewrite);
    if (!n || typeof n !== 'object') return n;
    const out: any = {};
    for (const [k, v] of Object.entries(n)) out[k] = k === '$ref' && typeof v === 'string' && v.startsWith('#') ? `${DOC_ID}${v}` : rewrite(v);
    return out;
  };
  const copy = rewrite(structuredClone(schema));
  return requestAjv(doc).compile(is31 ? copy : nullableToJsonSchema(copy));
}

const deref = (doc: OpenApiDoc, s: any, depth = 0): any => (s?.$ref && depth < 20 ? deref(doc, resolvePointer(doc, s.$ref.slice(1)).node, depth + 1) : s);
const runtimePointer = (path: PathSeg[]) => path.map((p) => '/' + (p === ARRAY ? '0' : String(p).replace(/~/g, '~0').replace(/\//g, '~1'))).join('');

function removeAt(root: any, path: PathSeg[]): any {
  const out = structuredClone(root);
  let node = out;
  for (const seg of path.slice(0, -1)) node = node?.[seg === ARRAY ? 0 : (seg as string)];
  const last = path[path.length - 1];
  if (node && typeof node === 'object' && last !== ARRAY) delete node[last as string];
  return out;
}

function setAt(root: any, path: PathSeg[], value: unknown): any {
  if (!path.length) return structuredClone(value);
  const out = structuredClone(root);
  let node = out;
  for (const seg of path.slice(0, -1)) node = node?.[seg === ARRAY ? 0 : (seg as string)];
  node[path[path.length - 1] === ARRAY ? 0 : (path[path.length - 1] as string)] = structuredClone(value);
  return out;
}

const COMPOSITE = ['oneOf', 'anyOf', 'if', 'dependentRequired', 'dependentSchemas', 'dependencies', 'not'];

/** Optional properties present in the value, outer ones first; never inside a oneOf / anyOf / conditional subtree. */
function optionalPaths(doc: OpenApiDoc, raw: any, value: unknown, path: PathSeg[], keep: Set<string>, depth = 0): PathSeg[][] {
  const s = deref(doc, raw);
  if (!s || depth > 12 || COMPOSITE.some((k) => s[k] !== undefined)) return [];
  const parts = [s, ...(Array.isArray(s.allOf) ? s.allOf.map((p: any) => deref(doc, p)) : [])];
  if (parts.some((p) => p && COMPOSITE.some((k) => p[k] !== undefined))) return [];
  if (Array.isArray(value)) return value.length && s.items ? optionalPaths(doc, s.items, value[0], [...path, ARRAY], keep, depth + 1) : [];
  if (!value || typeof value !== 'object') return [];
  const props = Object.assign({}, ...parts.map((p) => p?.properties ?? {}));
  const required = new Set(parts.flatMap((p) => p?.required ?? []));
  const out: PathSeg[][] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const here = [...path, k];
    if (!required.has(k) && props[k] !== undefined && !(path.length === 0 && keep.has(k))) out.push(here);
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (props[k] !== undefined) out.push(...optionalPaths(doc, props[k], v, [...path, k], keep, depth + 1));
  }
  return out;
}

/** oneOf / anyOf points in the value (like compositionGaps): where another branch can be sent. */
function compositions(doc: OpenApiDoc, raw: any, value: unknown, path: PathSeg[], depth = 0): { path: PathSeg[]; key: 'oneOf' | 'anyOf'; branches: any[] }[] {
  const s = deref(doc, raw);
  if (!s || depth > 12) return [];
  const out: { path: PathSeg[]; key: 'oneOf' | 'anyOf'; branches: any[] }[] = [];
  for (const key of ['oneOf', 'anyOf'] as const) if (Array.isArray(s[key]) && s[key].length > 1) out.push({ path, key, branches: s[key] });
  if (Array.isArray(value) && s.items && value.length) out.push(...compositions(doc, s.items, value[0], [...path, ARRAY], depth + 1));
  else if (value && typeof value === 'object' && !Array.isArray(value) && s.properties) {
    for (const [k, sub] of Object.entries<any>(s.properties)) if (k in (value as object)) out.push(...compositions(doc, sub, (value as any)[k], [...path, k], depth + 1));
  }
  return out;
}

/**
 * Variants of one payload. `schemaPointer` locates the operation's JSON request schema in the spec; `keep` lists
 * top-level fields that must stay (deps "fill": values from existing data). Gaps say what could not be varied.
 */
export function bodyVariants(doc: OpenApiDoc, schemaPointer: string, schema: any, payload: unknown, keep: string[] = []): { variants: BodyVariant[]; gaps: CoverageGap[] } {
  const variants: BodyVariant[] = [];
  const gaps: CoverageGap[] = [];
  if (!payload || typeof payload !== 'object') return { variants, gaps };
  const validate = requestValidator(doc, schemaPointer);
  if (!validate(payload)) return { variants, gaps }; // the example itself is not valid: the body cases already say so

  // optional-omitted: remove optional fields one by one (outer first), keeping each removal only while the payload
  // stays valid (minProperties, dependent rules...). Deterministic: the schema's own order.
  const candidates = optionalPaths(doc, schema, payload, [], new Set(keep));
  let current: unknown = payload;
  const removed: PathSeg[][] = [];
  for (const p of candidates) {
    if (removed.some((r) => r.length <= p.length && r.every((seg, i) => seg === p[i]))) continue; // its parent is gone
    const next = removeAt(current, p);
    if (validate(next)) {
      current = next;
      removed.push(p);
    }
  }
  if (removed.length) {
    variants.push({ kind: 'optional-omitted', location: 'request.body#', title: `accepts the payload with only its required fields (${removed.length} optional field(s) left out)`, remove: removed.map(runtimePointer) });
  } else if (candidates.length) {
    gaps.push({ code: 'CANNOT_ISOLATE_RULE', location: 'request.body#', rule: 'optional-omitted', reason: 'no optional field can be left out without breaking another rule of the schema' });
  }

  // variant: every other oneOf / anyOf branch with a valid sample.
  for (const c of compositions(doc, schema, payload, [])) {
    const at = runtimePointer(c.path);
    const sentValue = c.path.reduce<any>((n, seg) => n?.[seg === ARRAY ? 0 : (seg as string)], payload);
    // The branch(es) the example already sends are covered by the documented-success test.
    const sent = c.branches.map((b) => inlineValidator(doc, b)(sentValue));
    c.branches.forEach((branch, i) => {
      if (sent[i]) return;
      const loc = `request.body#${bodyPointer(c.path)}/@${i}`;
      const sample = sampleFromSchema(doc, branch);
      if (!sample.ok) {
        gaps.push({ code: 'UNCOVERED_VARIANT', location: `request.body#${bodyPointer(c.path)}`, rule: c.key, reason: `${c.key} branch ${i}: no valid sample (${sample.reason})` });
        return;
      }
      const candidate = setAt(payload, c.path, sample.value);
      if (!validate(candidate)) {
        gaps.push({ code: 'UNCOVERED_VARIANT', location: `request.body#${bodyPointer(c.path)}`, rule: c.key, reason: `${c.key} branch ${i}: its sample is not a valid payload (${(validate.errors ?? []).slice(0, 2).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ')})` });
        return;
      }
      variants.push({ kind: 'variant', location: loc, title: `accepts ${c.key} branch ${i} at ${bodyPointer(c.path) || '(body)'}`, set: { pointer: at, value: sample.value } });
    });
  }
  return { variants, gaps };
}
