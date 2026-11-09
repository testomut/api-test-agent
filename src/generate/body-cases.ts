import { resolvePointer, type OpenApiDoc } from '../spec/loader.js';
import { ARRAY, bodyPointer } from '../cases/ids.js';
import type { NegCase } from './negative.js';

/**
 * Request-body negative cases, recursive (docs/SUPPORT_MATRIX.md, stage 3).
 * Start from a VALID payload and break exactly ONE rule per case, at any depth: `request.body#/customer/name`,
 * `request.body#/items/*\/sku` (the first array element stands for `*`). A rule that cannot be broken without
 * breaking another one too (or without a valid element to start from) becomes a coverage gap, never a guess.
 */

export type PathSeg = string | typeof ARRAY;

export interface CoverageGap {
  code: string; // MISSING_VALID_SAMPLE, CANNOT_ISOLATE_RULE, UNSUPPORTED_SCHEMA_KEYWORD, CASE_LIMIT_REACHED, …
  location: string; // case location, e.g. request.body#/customer/address
  rule?: string;
  reason: string;
}

export interface BodyCaseResult {
  cases: NegCase[];
  gaps: CoverageGap[];
  /** Every case found before the limit. */
  potential: number;
  /** Cases dropped by the limit (also listed in gaps as CASE_LIMIT_REACHED). */
  dropped: { location: string; rule: string }[];
}

export const DEFAULT_MAX_BODY_CASES = 60;

const deref = (doc: OpenApiDoc, s: any, depth = 0): any => (s?.$ref && depth < 20 ? deref(doc, resolvePointer(doc, s.$ref.slice(1)).node, depth + 1) : s);
const typesOf = (s: any): string[] => (s?.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]);
const mainType = (s: any): string | undefined => typesOf(s).find((t) => t !== 'null') ?? (s?.properties ? 'object' : s?.items ? 'array' : undefined);
const allowsNull = (s: any) => typesOf(s).includes('null') || s?.nullable === true || (Array.isArray(s?.enum) && s.enum.includes(null));
const isNum = (t?: string) => t === 'number' || t === 'integer';

/** Merges `allOf` parts that are plain objects (properties, required); anything else is left for the gap check. */
function merged(doc: OpenApiDoc, raw: any): any {
  const s = deref(doc, raw);
  if (!s || !Array.isArray(s.allOf)) return s;
  const { allOf, ...rest } = s;
  const out: any = { ...rest };
  for (const partRaw of allOf) {
    const part = merged(doc, partRaw);
    if (!part || typeof part !== 'object') continue;
    for (const [k, v] of Object.entries<any>(part)) {
      if (k === 'properties') out.properties = { ...(out.properties ?? {}), ...v };
      else if (k === 'required') out.required = [...new Set([...(out.required ?? []), ...v])];
      else if (out[k] === undefined) out[k] = v;
    }
  }
  return out;
}

const clone = <T>(v: T): T => structuredClone(v);
function setAt(root: unknown, path: PathSeg[], value: unknown): unknown {
  if (!path.length) return value;
  const out = clone(root) as any;
  let node = out;
  for (let i = 0; i < path.length - 1; i++) node = node[path[i] === ARRAY ? 0 : (path[i] as string)];
  const last = path[path.length - 1];
  node[last === ARRAY ? 0 : (last as string)] = value;
  return out;
}
function removeAt(root: unknown, path: PathSeg[]): unknown {
  const out = clone(root) as any;
  let node = out;
  for (let i = 0; i < path.length - 1; i++) node = node[path[i] === ARRAY ? 0 : (path[i] as string)];
  delete node[path[path.length - 1] as string];
  return out;
}

const label = (path: PathSeg[]) => path.map((p, i) => (p === ARRAY ? '[]' : `${i ? '.' : ''}${p}`)).join('') || '(body)';

/** A string that does not match `pattern`, within the length limits; undefined when none of the candidates works. */
function violatePattern(pattern: string, minLength = 0, maxLength = Infinity): string | undefined {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'u');
  } catch {
    return undefined;
  }
  const seeds = ['!', '~', ' ', '#', '0', 'a', 'Z', '-', '_'];
  for (const seed of seeds) {
    for (let len = Math.max(minLength, 1); len <= Math.min(maxLength, Math.max(minLength, 1) + 3); len++) {
      const v = seed.repeat(len);
      if (!re.test(v)) return v;
    }
  }
  return undefined;
}

/** Strings that are certainly not of the format (and still strings). */
const BAD_FORMAT: Record<string, string> = {
  email: 'not-an-email',
  uuid: 'not-a-uuid',
  'date-time': 'not-a-date-time',
  date: 'not-a-date',
  time: 'not-a-time',
  uri: 'not a uri',
  url: 'not a url',
  hostname: '-not_a_host-',
  ipv4: '999.999.999.999',
  ipv6: 'not-an-ipv6',
};

function wrongTypeValue(t: string): unknown {
  return { string: 12345, integer: 'not-a-number', number: 'not-a-number', boolean: 'not-a-boolean', array: 'not-an-array', object: 'not-an-object' }[t];
}

export function bodyCasesDetailed(doc: OpenApiDoc, rawSchema: any, base: unknown, schemaName = 'body', maxCases = DEFAULT_MAX_BODY_CASES): BodyCaseResult {
  const cases: NegCase[] = [];
  const gaps: CoverageGap[] = [];
  const loc = (path: PathSeg[]) => `request.body#${bodyPointer(path)}`;
  const add = (path: PathSeg[], rule: string, title: string, data: unknown) =>
    cases.push({ title, source: `${schemaName}${path.length ? '.' + label(path) : ''}.${rule}`, data, target: { in: 'body', path, rule } });
  const gap = (path: PathSeg[], code: string, reason: string, rule?: string): void => {
    gaps.push({ code, location: loc(path), ...(rule ? { rule } : {}), reason });
  };

  const walk = (raw: any, value: unknown, path: PathSeg[], depth: number): void => {
    if (depth > 12) return gap(path, 'UNSUPPORTED_SCHEMA_KEYWORD', 'schema nesting deeper than 12 levels');
    const s = merged(doc, raw);
    if (!s || typeof s !== 'object') return;
    if (s.readOnly) return; // not sent in requests
    const name = label(path);
    // Composition other than allOf: which branch rejects a broken value is not deterministic.
    for (const k of ['oneOf', 'anyOf', 'not']) {
      if (s[k] !== undefined) {
        gap(path, 'UNSUPPORTED_SCHEMA_KEYWORD', `${k}${s.discriminator ? ' with discriminator' : ''}: a broken value may still match another branch, so no case is derived below this point`, k);
        return;
      }
    }
    const t = mainType(s);

    // type and null: the value of another type / null where null is not allowed.
    if (path.length && t) {
      const fixed = Array.isArray(s.enum) || s.const !== undefined; // another type / null would also break enum / const
      const wt = wrongTypeValue(t);
      if (fixed) gap(path, 'CANNOT_ISOLATE_RULE', 'a value of another type (or null) would also break enum / const; the enum / const case covers it', 'type');
      else {
        if (wt !== undefined) add(path, 'type', `"${name}" has wrong type (${t} expected)`, setAt(base, path, wt));
        if (!allowsNull(s)) add(path, 'nullable', `"${name}" is null (not nullable)`, setAt(base, path, null));
      }
    }
    // enum / const for any scalar type.
    if (Array.isArray(s.enum) && s.enum.length && path.length) {
      const bad = t === 'string' ? '__not_in_enum__' : isNum(t) ? Math.max(...s.enum.filter((x: unknown) => typeof x === 'number')) + 1 : t === 'boolean' ? [true, false].find((b) => !s.enum.includes(b)) : undefined;
      if (bad === undefined || !Number.isFinite(bad as number) && isNum(t)) gap(path, 'CANNOT_ISOLATE_RULE', `enum ${JSON.stringify(s.enum)} covers every value of type ${t}`, 'enum');
      else add(path, 'enum', `"${name}" not in enum`, setAt(base, path, bad));
    }
    if (s.const !== undefined && path.length) {
      const c = s.const;
      const bad = typeof c === 'string' ? `${c}__other` : typeof c === 'number' ? c + 1 : typeof c === 'boolean' ? !c : undefined;
      if (bad === undefined) gap(path, 'CANNOT_ISOLATE_RULE', 'const of a non-scalar type', 'const');
      else add(path, 'const', `"${name}" differs from const ${JSON.stringify(c)}`, setAt(base, path, bad));
    }

    if (t === 'string' && path.length) {
      const others = (except: string) => ['pattern', 'format', 'enum', 'const'].filter((k) => k !== except && s[k] !== undefined);
      const lengthOk = (v: string) => (s.minLength === undefined || v.length >= s.minLength) && (s.maxLength === undefined || v.length <= s.maxLength);
      if (typeof s.minLength === 'number' && s.minLength > 0) {
        if (others('').length) gap(path, 'CANNOT_ISOLATE_RULE', `a shorter string would also break ${others('').join(', ')}`, 'minLength');
        else add(path, 'minLength', `"${name}" shorter than minLength ${s.minLength}`, setAt(base, path, 'x'.repeat(s.minLength - 1)));
      }
      if (typeof s.maxLength === 'number') {
        if (others('').length) gap(path, 'CANNOT_ISOLATE_RULE', `a longer string would also break ${others('').join(', ')}`, 'maxLength');
        else add(path, 'maxLength', `"${name}" longer than maxLength ${s.maxLength}`, setAt(base, path, 'x'.repeat(s.maxLength + 1)));
      }
      if (typeof s.pattern === 'string') {
        const v = others('pattern').length ? undefined : violatePattern(s.pattern, s.minLength, s.maxLength);
        if (v === undefined) gap(path, 'CANNOT_ISOLATE_RULE', others('pattern').length ? `a non-matching string would also break ${others('pattern').join(', ')}` : `no simple string violates ${s.pattern} within the length limits`, 'pattern');
        else add(path, 'pattern', `"${name}" does not match pattern ${s.pattern}`, setAt(base, path, v));
      }
      if (typeof s.format === 'string') {
        const v = BAD_FORMAT[s.format];
        if (v === undefined) gap(path, 'UNSUPPORTED_SCHEMA_KEYWORD', `format "${s.format}" has no known invalid value`, 'format');
        else if (others('format').length || !lengthOk(v)) gap(path, 'CANNOT_ISOLATE_RULE', `an invalid ${s.format} would also break ${[...others('format'), ...(lengthOk(v) ? [] : ['the length limits'])].join(', ')}`, 'format');
        else add(path, 'format', `"${name}" is not a valid ${s.format}`, setAt(base, path, v));
      }
    }

    if (isNum(t) && path.length) {
      const step = typeof s.multipleOf === 'number' && s.multipleOf > 0 ? s.multipleOf : t === 'integer' ? 1 : 1;
      const isMultiple = (v: number) => typeof s.multipleOf !== 'number' || Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) < 1e-9;
      const inRange = (v: number, skip: string) =>
        (skip === 'minimum' || s.minimum === undefined || v >= s.minimum) &&
        (skip === 'maximum' || s.maximum === undefined || v <= s.maximum) &&
        (skip === 'exclusiveMinimum' || typeof s.exclusiveMinimum !== 'number' || v > s.exclusiveMinimum) &&
        (skip === 'exclusiveMaximum' || typeof s.exclusiveMaximum !== 'number' || v < s.exclusiveMaximum);
      const tryAdd = (rule: string, v: number, title: string) => {
        if ((t === 'integer' && !Number.isInteger(v)) || !isMultiple(v) || !inRange(v, rule) || (Array.isArray(s.enum) && s.enum.length)) gap(path, 'CANNOT_ISOLATE_RULE', `${title}: the value ${v} would also break another constraint`, rule);
        else add(path, rule, title, setAt(base, path, v));
      };
      if (typeof s.minimum === 'number') {
        // OpenAPI 3.0: exclusiveMinimum: true makes the minimum itself invalid.
        if (s.exclusiveMinimum === true) tryAdd('exclusiveMinimum', s.minimum, `"${name}" equals the exclusive minimum ${s.minimum}`);
        else tryAdd('minimum', s.minimum - step, `"${name}" below minimum ${s.minimum}`);
      }
      if (typeof s.maximum === 'number') {
        if (s.exclusiveMaximum === true) tryAdd('exclusiveMaximum', s.maximum, `"${name}" equals the exclusive maximum ${s.maximum}`);
        else tryAdd('maximum', s.maximum + step, `"${name}" above maximum ${s.maximum}`);
      }
      if (typeof s.exclusiveMinimum === 'number') tryAdd('exclusiveMinimum', s.exclusiveMinimum, `"${name}" equals the exclusive minimum ${s.exclusiveMinimum}`);
      if (typeof s.exclusiveMaximum === 'number') tryAdd('exclusiveMaximum', s.exclusiveMaximum, `"${name}" equals the exclusive maximum ${s.exclusiveMaximum}`);
      if (typeof s.multipleOf === 'number' && s.multipleOf > 0) {
        const cur = typeof value === 'number' ? value : 0;
        const candidates = t === 'integer' ? [cur + 1, cur - 1] : [cur + s.multipleOf / 2, cur - s.multipleOf / 2];
        const v = candidates.find((c) => (t !== 'integer' || Number.isInteger(c)) && !isMultipleOf(c, s.multipleOf) && inRange(c, 'multipleOf') && !(Array.isArray(s.enum) && s.enum.length));
        if (v === undefined) gap(path, 'CANNOT_ISOLATE_RULE', `no value next to ${cur} breaks multipleOf ${s.multipleOf} alone`, 'multipleOf');
        else add(path, 'multipleOf', `"${name}" is not a multiple of ${s.multipleOf}`, setAt(base, path, v));
      }
    }

    if (t === 'array') {
      const arr = Array.isArray(value) ? value : undefined;
      if (!arr) return gap(path, 'MISSING_VALID_SAMPLE', 'no valid array value to start from');
      if (typeof s.minItems === 'number' && s.minItems > 0) add(path, 'minItems', `"${name}" has fewer than minItems ${s.minItems}`, setAt(base, path, arr.slice(0, s.minItems - 1)));
      if (typeof s.maxItems === 'number') {
        if (!arr.length) gap(path, 'MISSING_VALID_SAMPLE', 'no element to repeat', 'maxItems');
        else if (s.uniqueItems) gap(path, 'CANNOT_ISOLATE_RULE', 'repeating an element would also break uniqueItems', 'maxItems');
        else add(path, 'maxItems', `"${name}" has more than maxItems ${s.maxItems}`, setAt(base, path, Array.from({ length: s.maxItems + 1 }, (_, i) => arr[i % arr.length])));
      }
      if (s.uniqueItems === true) {
        if (!arr.length) gap(path, 'MISSING_VALID_SAMPLE', 'no element to duplicate', 'uniqueItems');
        else {
          const dup = arr.length >= 2 ? [arr[0], arr[0], ...arr.slice(2)] : [arr[0], arr[0]];
          if (typeof s.maxItems === 'number' && dup.length > s.maxItems) gap(path, 'CANNOT_ISOLATE_RULE', 'a duplicate element would also break maxItems', 'uniqueItems');
          else add(path, 'uniqueItems', `"${name}" has duplicate items`, setAt(base, path, dup));
        }
      }
      if (s.items) {
        if (!arr.length) gap([...path, ARRAY], 'MISSING_VALID_SAMPLE', 'the array has no element to break constraints of its items');
        else walk(s.items, arr[0], [...path, ARRAY], depth + 1);
      }
      return;
    }

    if (t === 'object' || s.properties) {
      const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
      if (!obj) return gap(path, 'MISSING_VALID_SAMPLE', 'no valid object value to start from');
      const props: Record<string, any> = s.properties ?? {};
      const required: string[] = s.required ?? [];
      for (const r of required) {
        if (r in obj) add([...path, r], 'required', `missing required field "${label([...path, r])}"`, removeAt(base, [...path, r]));
        else gap([...path, r], 'MISSING_VALID_SAMPLE', `required "${r}" has no valid value in the sample`, 'required');
      }
      if (s.additionalProperties === false) {
        const extra = '__unexpected_field__';
        if (typeof s.maxProperties === 'number' && Object.keys(obj).length + 1 > s.maxProperties) gap(path, 'CANNOT_ISOLATE_RULE', 'an unknown field would also break maxProperties', 'additionalProperties');
        else add(path, 'additionalProperties', path.length ? `"${name}" has an unknown field (additionalProperties: false)` : 'unknown field is rejected (additionalProperties: false)', setAt(base, path, { ...obj, [extra]: 'api-agent' }));
      }
      if (typeof s.minProperties === 'number' && s.minProperties > 0) {
        // Drop optional properties only, until one fewer than minProperties remain.
        const count = Object.keys(obj).length;
        const drop = count - s.minProperties + 1;
        const optional = Object.keys(obj).filter((k) => !required.includes(k));
        if (count < s.minProperties) gap(path, 'MISSING_VALID_SAMPLE', 'the sample already breaks minProperties');
        else if (optional.length < drop) gap(path, 'CANNOT_ISOLATE_RULE', 'fewer properties would also drop a required one', 'minProperties');
        else {
          const removed = optional.slice(0, drop);
          add(path, 'minProperties', `"${name}" has fewer than minProperties ${s.minProperties}`, setAt(base, path, Object.fromEntries(Object.entries(obj).filter(([k]) => !removed.includes(k)))));
        }
      }
      if (typeof s.maxProperties === 'number') {
        const free = Object.keys(props).filter((k) => !(k in obj) && !deref(doc, props[k])?.readOnly);
        const need = s.maxProperties + 1 - Object.keys(obj).length;
        if (need <= 0) gap(path, 'MISSING_VALID_SAMPLE', 'the sample already breaks maxProperties');
        else if (s.additionalProperties !== false) add(path, 'maxProperties', `"${name}" has more than maxProperties ${s.maxProperties}`, setAt(base, path, { ...obj, ...Object.fromEntries(Array.from({ length: need }, (_, i) => [`__extra_${i}__`, 'api-agent'])) }));
        else gap(path, 'CANNOT_ISOLATE_RULE', `extra properties would break additionalProperties: false (${free.length} documented optional ones have no valid sample)`, 'maxProperties');
      }
      for (const [prop, sub] of Object.entries(props)) {
        if (prop in obj) walk(sub, obj[prop], [...path, prop], depth + 1);
      }
    }
  };

  walk(rawSchema, base, [], 0);
  const potential = cases.length;
  const kept = cases.slice(0, maxCases);
  const dropped = cases.slice(maxCases).map((c) => ({ location: loc((c.target as any).path), rule: c.target!.rule }));
  for (const d of dropped) gaps.push({ code: 'CASE_LIMIT_REACHED', location: d.location, rule: d.rule, reason: `limit of ${maxCases} body cases per operation (--max-cases)` });
  return { cases: kept, gaps, potential, dropped };
}

function isMultipleOf(v: number, m: number): boolean {
  return Math.abs(v / m - Math.round(v / m)) < 1e-9;
}
