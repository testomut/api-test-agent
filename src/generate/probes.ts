import type { Operation } from '../types.js';
import { location } from '../cases/ids.js';
import type { CoverageGap } from './body-cases.js';
import type { NegCase } from './negative.js';
import { requiredRequest, sendable } from './param-cases.js';

/**
 * Exploratory query-parameter probes (docs/SUPPORT_MATRIX.md, "Parameters: exploratory probes").
 *
 * Inputs a real client sends by mistake: an empty value, text where a number is expected, a decimal for an integer,
 * zero, a negative number, a very large number, special characters, another spelling of a boolean or an enum value,
 * and a missing required parameter. What the API must answer is NOT specified for them (or no rejection is
 * documented), so a probe never asserts the API's behavior: it records what came back (status, documented or not,
 * server error, contract mismatch) as an observation. Confirmed checks stay in the constraint cases; a value that a
 * confirmed case already sends is not probed again. Only safe operations (GET / HEAD) are probed.
 */

export type ProbeKind = 'empty' | 'text' | 'decimal' | 'zero' | 'negative' | 'large' | 'special' | 'numeric' | 'case' | 'missing';

export interface Probe {
  param: string;
  kind: ProbeKind;
  /** Location for the case ID: request.query#/<name>/<kind>. */
  location: string;
  title: string;
  /** The whole query (required parameters with their documented values plus the probe). */
  params: Record<string, string | number | boolean>;
  /** The probe's value on the wire; null = the parameter is not sent. */
  value: string | null;
}

export const MAX_PROBES_PER_OPERATION = 24;

const typeOf = (s: any): string | undefined => (Array.isArray(s?.type) ? s.type.find((t: string) => t !== 'null') : s?.type);

/** The probe values of one scalar parameter, by kind, before deduplication. */
function candidates(schema: any, required: boolean): { kind: ProbeKind; value: string | null; why: string }[] {
  const t = typeOf(schema);
  const out: { kind: ProbeKind; value: string | null; why: string }[] = [];
  if (required) out.push({ kind: 'missing', value: null, why: 'the required parameter is not sent' });
  out.push({ kind: 'empty', value: '', why: 'an empty value' });
  if (t === 'integer' || t === 'number') {
    out.push({ kind: 'text', value: 'abc', why: 'text where a number is expected' });
    if (t === 'integer') out.push({ kind: 'decimal', value: '1.5', why: 'a decimal for an integer' });
    out.push({ kind: 'zero', value: '0', why: 'zero' });
    out.push({ kind: 'negative', value: '-1', why: 'a negative number' });
    out.push({ kind: 'large', value: '99999999999999999999', why: 'a number beyond 64-bit integers' });
  } else if (t === 'boolean') {
    out.push({ kind: 'text', value: 'maybe', why: 'text that is not a boolean' });
    out.push({ kind: 'numeric', value: '1', why: '1 instead of true' });
  } else if (t === 'string') {
    if (Array.isArray(schema.enum) && typeof schema.enum[0] === 'string') {
      const other = schema.enum[0].toUpperCase() === schema.enum[0] ? schema.enum[0].toLowerCase() : schema.enum[0].toUpperCase();
      if (other !== schema.enum[0] && !schema.enum.includes(other)) out.push({ kind: 'case', value: other, why: 'a documented value in another letter case' });
    } else {
      out.push({ kind: 'special', value: `'"<>%;&`, why: 'special characters' });
      if (typeof schema.maxLength !== 'number') out.push({ kind: 'large', value: 'x'.repeat(1000), why: '1000 characters, no documented maximum' });
    }
  }
  return out;
}

/** Probe kinds a confirmed constraint case of the parameter already exercises (logically equivalent inputs). */
function coveredKinds(schema: any, cases: NegCase[]): Set<ProbeKind> {
  const rules = new Set(cases.map((c) => (c.target && c.target.in !== 'body' && c.target.variant ? `${c.target.rule}/${c.target.variant}` : c.target?.rule)));
  const out = new Set<ProbeKind>();
  if (rules.has('required')) out.add('missing');
  if (rules.has('type')) out.add('text'); // non-numeric / non-boolean text
  if (rules.has('type/decimal')) out.add('decimal');
  const lowRule = rules.has('minimum') || rules.has('exclusiveMinimum');
  const low = typeof schema.minimum === 'number' ? schema.minimum : typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : undefined;
  if (lowRule && low !== undefined && low >= 0) out.add('negative'); // below a non-negative minimum
  if (lowRule && low !== undefined && (low > 0 || (low === 0 && (schema.exclusiveMinimum === true || schema.exclusiveMinimum === 0)))) out.add('zero');
  // Inside the documented range a value is valid by the spec, not an open question.
  const inRange = (v: number) => (typeof schema.minimum !== 'number' || v >= schema.minimum) && (typeof schema.maximum !== 'number' || v <= schema.maximum) && (typeof schema.exclusiveMinimum !== 'number' || v > schema.exclusiveMinimum) && (typeof schema.exclusiveMaximum !== 'number' || v < schema.exclusiveMaximum);
  const bounded = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].some((k) => typeof schema[k] === 'number');
  if (bounded && inRange(0)) out.add('zero');
  if (bounded && inRange(-1)) out.add('negative');
  if (rules.has('maximum') || rules.has('exclusiveMaximum')) out.add('large');
  if (rules.has('maxLength')) out.add('large');
  if (rules.has('minLength') && (schema.minLength ?? 0) >= 1) out.add('empty');
  return out;
}

/**
 * Probes of an operation. `confirmed` are its constraint cases: a value they already send for a parameter (and,
 * for a required parameter, its absence) is not probed again.
 */
export function paramProbes(op: Operation, confirmed: NegCase[]): { probes: Probe[]; gaps: CoverageGap[] } {
  const probes: Probe[] = [];
  const gaps: CoverageGap[] = [];
  const query = op.params.filter((p) => p.in === 'query' && sendable(p) && ['integer', 'number', 'boolean', 'string'].includes(typeOf(p.schema) ?? ''));
  if (!query.length) return { probes, gaps };
  if (!['get', 'head'].includes(op.method)) {
    gaps.push({ code: 'UNSAFE_LIVE_CHECK', location: 'operation', rule: 'probe', reason: `exploratory query probes are sent to GET / HEAD only: ${op.key} could change data` });
    return { probes, gaps };
  }
  const base = requiredRequest(op);
  if (base.missing.length) return { probes, gaps }; // no valid request to start from: paramCases reports it
  const unknownPath = op.params.filter((p) => p.in === 'path' && p.knownValue === undefined);
  if (unknownPath.length) {
    gaps.push({ code: 'MISSING_RESOURCE_SOURCE', location: 'operation', rule: 'probe', reason: `no value for ${unknownPath.map((p) => `path "${p.name}"`).join(', ')}: a missing resource would answer before the parameter is read` });
    return { probes, gaps };
  }
  for (const p of query) {
    const sent = new Set(confirmed.filter((c) => c.sent?.name === p.name).map((c) => (c.sent!.value === null ? '\u0000missing' : c.sent!.value)));
    const covered = coveredKinds(p.schema ?? {}, confirmed.filter((c) => c.target && c.target.in === 'query' && c.target.field === p.name));
    for (const c of candidates(p.schema ?? {}, !!p.required)) {
      // A confirmed case already sends this value, or one equivalent to it (same documented rule): no probe.
      if (sent.has(c.value === null ? '\u0000missing' : c.value) || covered.has(c.kind)) continue;
      const params = { ...base.params };
      delete params[p.name];
      if (c.value !== null) params[p.name] = c.value;
      probes.push({ param: p.name, kind: c.kind, location: `${location.query(p.name)}/${c.kind}`, title: `query "${p.name}": ${c.why}${c.value !== null && c.value.length <= 24 ? ` (${JSON.stringify(c.value)})` : ''}`, params, value: c.value });
    }
  }
  if (probes.length > MAX_PROBES_PER_OPERATION) {
    for (const p of probes.slice(MAX_PROBES_PER_OPERATION)) gaps.push({ code: 'CASE_LIMIT_REACHED', location: p.location, rule: 'probe', reason: `more than ${MAX_PROBES_PER_OPERATION} probes for ${op.key}` });
    probes.length = MAX_PROBES_PER_OPERATION;
  }
  return { probes, gaps };
}
