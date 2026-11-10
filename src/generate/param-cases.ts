import type { OpenApiDoc } from '../spec/loader.js';
import type { Operation, ParamInfo } from '../types.js';
import { location } from '../cases/ids.js';
import { bodyCasesDetailed, type CoverageGap } from './body-cases.js';
import type { NegCase } from './negative.js';
import { sampleFromSchema } from './sample.js';

/**
 * Parameter negative cases for query, header, cookie and path (docs/SUPPORT_MATRIX.md, stage 4).
 * Each case is a valid request (every required parameter with its documented value) with exactly one parameter
 * breaking exactly one rule. The rules come from the same recursive engine as bodies; what does not make sense on the
 * wire is dropped (a string parameter cannot have the wrong type, null cannot be sent), and what cannot be sent
 * safely or serialized deterministically is a gap.
 */

export type ParamIn = 'query' | 'header' | 'cookie' | 'path';

export interface ParamRequest {
  /** Query as an object, or a serialized string when an array needs its documented style. */
  params?: Record<string, string | number | boolean> | string;
  headers?: Record<string, string>;
  /** Path parameter values by name (only the parameter under test; the others keep their documented values). */
  path?: Record<string, string>;
}

/** Headers the spec cannot define as parameters (OpenAPI ignores them) or that credentials own. */
const RESERVED_HEADERS = new Set(['authorization', 'content-type', 'accept']);
const NUMERIC_RULES = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];

export const sendable = (p: ParamInfo) => !(p.in === 'header' && RESERVED_HEADERS.has(p.name.toLowerCase()));

/** Required query / header / cookie parameters with their documented values: the valid part of every request. */
export function requiredRequest(op: Operation): { params: Record<string, string | number | boolean>; headers: Record<string, string>; missing: ParamInfo[] } {
  const params: Record<string, string | number | boolean> = {};
  const cookies: string[] = [];
  const headers: Record<string, string> = {};
  const missing: ParamInfo[] = [];
  for (const p of op.params.filter((x) => x.required && x.in !== 'path' && sendable(x))) {
    if (p.knownValue === undefined || (typeof p.knownValue === 'object' && p.knownValue !== null)) {
      missing.push(p);
      continue;
    }
    const v = p.knownValue as string | number | boolean;
    if (p.in === 'query') params[p.name] = v;
    else if (p.in === 'header') headers[p.name] = String(v);
    else if (p.in === 'cookie') cookies.push(`${p.name}=${String(v)}`);
  }
  if (cookies.length) headers.Cookie = cookies.join('; ');
  return { params, headers, missing };
}

/** OpenAPI serialization of a query array: form (explode: true → repeated keys, false → comma), spaceDelimited, pipeDelimited. */
function serializeQuery(p: ParamInfo & { style?: string; explode?: boolean }, value: unknown, rest: Record<string, string | number | boolean>): string | undefined {
  const parts = Object.entries(rest).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  if (!Array.isArray(value)) return undefined;
  if (value.some((v) => v !== null && typeof v === 'object')) return undefined;
  const style = p.style ?? 'form';
  const explode = p.explode ?? style === 'form';
  const name = encodeURIComponent(p.name);
  if (style === 'form' && explode) parts.push(...value.map((v) => `${name}=${encodeURIComponent(String(v))}`));
  else if (style === 'form') parts.push(`${name}=${value.map((v) => encodeURIComponent(String(v))).join(',')}`);
  else if (style === 'spaceDelimited' && !explode) parts.push(`${name}=${value.map((v) => encodeURIComponent(String(v))).join('%20')}`);
  else if (style === 'pipeDelimited' && !explode) parts.push(`${name}=${value.map((v) => encodeURIComponent(String(v))).join('|')}`);
  else return undefined;
  return parts.join('&');
}

const locOf = (where: ParamIn, name: string) =>
  where === 'query' ? location.query(name) : where === 'header' ? location.header(name) : where === 'cookie' ? location.cookie(name) : location.path(name);

export function paramCasesDetailed(doc: OpenApiDoc, op: Operation, opts: { allowPath: boolean; allowOthers: boolean }): { cases: (NegCase & { request: ParamRequest })[]; gaps: CoverageGap[] } {
  const cases: (NegCase & { request: ParamRequest })[] = [];
  const gaps: CoverageGap[] = [];
  const base = requiredRequest(op);
  if (base.missing.length) {
    for (const p of base.missing) gaps.push({ code: 'MISSING_VALID_SAMPLE', location: locOf(p.in as ParamIn, p.name), reason: `required ${p.in} "${p.name}" has no documented value, so no valid request can be built` });
    return { cases, gaps };
  }
  const isWrite = !['get', 'head', 'options'].includes(op.method);
  for (const p of op.params.filter(sendable) as (ParamInfo & { style?: string; explode?: boolean })[]) {
    const where = p.in as ParamIn;
    const loc = locOf(where, p.name);
    const s = p.schema ?? {};
    if (where === 'path' ? !opts.allowPath : !opts.allowOthers) continue;
    if (where === 'path' && op.params.some((x) => x.in === 'path' && x !== p && x.knownValue === undefined)) {
      gaps.push({ code: 'MISSING_RESOURCE_SOURCE', location: loc, reason: 'another path parameter has no documented value' });
      continue;
    }
    // A valid value of the parameter under test to start from.
    let value: unknown = p.knownValue;
    if (value === undefined) {
      const sample = sampleFromSchema(doc, s);
      if (sample.ok) value = sample.value;
    }
    if (value === undefined) {
      // A scalar optional parameter is not sent in the valid request; its cases set the violating value directly,
      // so a placeholder is enough. Arrays need a real element to start from.
      const scalar = !['array', 'object'].includes(Array.isArray(s.type) ? s.type.find((x: string) => x !== 'null') : s.type);
      if (scalar && !p.required) value = null;
      else {
        gaps.push({ code: 'MISSING_VALID_SAMPLE', location: loc, reason: `${where} "${p.name}" has no documented or derivable valid value` });
        continue;
      }
    }
    const required = p.required && where !== 'path';
    const holder = { type: 'object', properties: { [p.name]: s }, ...(required ? { required: [p.name] } : {}) };
    const r = bodyCasesDetailed(doc, holder, { [p.name]: value }, where, 1000);
    const t = Array.isArray(s.type) ? s.type.find((x: string) => x !== 'null') : s.type;
    for (const g of r.gaps) if (g.location !== 'request.body#') gaps.push({ ...g, location: loc });
    for (const c of r.cases) {
      const tgt = c.target as { path: (string | symbol)[]; rule: string };
      const rule = tgt.rule;
      // On the wire every value is text: a string parameter cannot have a wrong type, null cannot be sent,
      // and a single value is a valid one-element array.
      if (rule === 'nullable' || (rule === 'type' && (t === 'string' || t === 'array' || t === undefined))) continue;
      if (tgt.path.length > 1) {
        gaps.push({ code: 'UNSUPPORTED_SCHEMA_KEYWORD', location: loc, rule, reason: `constraints of array items / object members in a ${where} parameter are not derived` });
        continue;
      }
      if (where === 'path' && isWrite && NUMERIC_RULES.includes(rule)) {
        gaps.push({ code: 'UNSAFE_LIVE_CHECK', location: loc, rule, reason: `an out-of-range id could address an existing record of ${op.key}` });
        continue;
      }
      const data = c.data as Record<string, unknown>;
      const missing = !(p.name in data);
      const v = data[p.name];
      const request: ParamRequest = {};
      const params = { ...base.params };
      const headers = { ...base.headers };
      if (where === 'query') {
        delete params[p.name];
        if (missing) request.params = params;
        else if (Array.isArray(v)) {
          const q = serializeQuery(p, v, params);
          if (q === undefined) {
            gaps.push({ code: 'UNSUPPORTED_SCHEMA_KEYWORD', location: loc, rule, reason: `style "${p.style ?? 'form'}" / explode ${p.explode ?? '(default)'} is not serialized` });
            continue;
          }
          request.params = q;
        } else if (v !== null && typeof v === 'object') {
          gaps.push({ code: 'UNSUPPORTED_SCHEMA_KEYWORD', location: loc, rule, reason: 'object query parameters are not serialized' });
          continue;
        } else request.params = { ...params, [p.name]: v as string | number | boolean };
      } else {
        if (Object.keys(params).length) request.params = params;
        if (where === 'header') {
          for (const k of Object.keys(headers)) if (k.toLowerCase() === p.name.toLowerCase()) delete headers[k];
          if (!missing) {
            if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
              gaps.push({ code: 'UNSUPPORTED_SCHEMA_KEYWORD', location: loc, rule, reason: 'object headers are not serialized' });
              continue;
            }
            headers[p.name] = Array.isArray(v) ? v.map(String).join(',') : String(v); // style: simple
          }
        } else if (where === 'cookie') {
          const others = (headers.Cookie ?? '').split('; ').filter((x) => x && !x.startsWith(`${p.name}=`));
          if (!missing) {
            if (v !== null && typeof v === 'object') {
              gaps.push({ code: 'UNSUPPORTED_SCHEMA_KEYWORD', location: loc, rule, reason: 'array / object cookies are not serialized' });
              continue;
            }
            others.push(`${p.name}=${String(v)}`);
          }
          if (others.length) headers.Cookie = others.join('; ');
          else delete headers.Cookie;
        } else {
          if (v !== null && typeof v === 'object') {
            gaps.push({ code: 'UNSUPPORTED_SCHEMA_KEYWORD', location: loc, rule, reason: 'array / object path parameters are not serialized' });
            continue;
          }
          request.path = { [p.name]: String(v) };
        }
      }
      if (Object.keys(headers).length) request.headers = headers;
      const title = c.title.replace(/^"([^"]*)"/, `${where} "$1"`).replace(/^missing required field "([^"]*)"/, `missing required ${where} "$1"`);
      cases.push({ title, source: `${where}.${p.name}.${rule}`, request, target: { in: where, field: p.name, rule }, ...(where === 'query' && !Array.isArray(v) ? { sent: { name: p.name, value: missing ? null : String(v) } } : {}) });
    }
    // An integer parameter given a decimal: numeric text, so a lenient parser may round it, but not an integer.
    // The value stays inside the documented bounds, so only the type is broken; not with multipleOf > 1.
    if (t === 'integer' && where !== 'path') {
      const at = typeof value === 'number' ? value : typeof s.minimum === 'number' ? s.minimum : 1;
      const inRange = (x: number) => (typeof s.minimum !== 'number' || x >= s.minimum) && (typeof s.maximum !== 'number' || x <= s.maximum) && (typeof s.exclusiveMinimum !== 'number' || x > s.exclusiveMinimum) && (typeof s.exclusiveMaximum !== 'number' || x < s.exclusiveMaximum);
      const decimal = [at + 0.5, at - 0.5].find(inRange);
      if (typeof s.multipleOf === 'number' && s.multipleOf !== 1) gaps.push({ code: 'CANNOT_ISOLATE_RULE', location: loc, rule: 'type', reason: `a decimal would also break multipleOf ${s.multipleOf}` });
      else if (Array.isArray(s.enum)) gaps.push({ code: 'CANNOT_ISOLATE_RULE', location: loc, rule: 'type', reason: 'a decimal would also break enum; the enum case covers it' });
      else if (decimal === undefined) gaps.push({ code: 'CANNOT_ISOLATE_RULE', location: loc, rule: 'type', reason: 'no decimal fits inside the documented bounds' });
      else {
        const params = { ...base.params };
        const headers = { ...base.headers };
        const request: ParamRequest = {};
        if (where === 'query') request.params = { ...params, [p.name]: String(decimal) };
        else {
          if (Object.keys(params).length) request.params = params;
          if (where === 'header') headers[p.name] = String(decimal);
          else headers.Cookie = [...(headers.Cookie ?? '').split('; ').filter((x) => x && !x.startsWith(`${p.name}=`)), `${p.name}=${decimal}`].join('; ');
        }
        if (Object.keys(headers).length) request.headers = headers;
        cases.push({ title: `${where} "${p.name}" is a decimal (${decimal}), not an integer`, source: `${where}.${p.name}.type.decimal`, request, target: { in: where, field: p.name, rule: 'type', variant: 'decimal' }, ...(where === 'query' ? { sent: { name: p.name, value: String(decimal) } } : {}) });
      }
    }
  }
  return { cases, gaps };
}
