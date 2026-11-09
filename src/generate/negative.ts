import type { Operation } from '../types.js';
import { resolvePointer, type OpenApiDoc } from '../spec/loader.js';

/**
 * Negative cases derived ONLY from what the spec states:
 *  - a constraint to violate (required, type, min/max, length, enum, additionalProperties, minProperties)
 *  - AND a documented rejection status for the operation (400 / 422 / 4XX, 404, 401).
 * No documented rejection → no negative case: the expected result would be invented.
 */
export interface NegCase {
  title: string;
  source: string;
  data?: unknown;
  query?: Record<string, unknown>;
}

const MAX_CASES = 20;

export function documentedRejections(op: Operation): { validation: string[]; notFound: boolean; unauthorized: boolean } {
  const codes = op.responses.map((r) => r.status.toUpperCase());
  return {
    validation: codes.filter((c) => c === '400' || c === '422' || c === '4XX'),
    notFound: codes.includes('404'),
    unauthorized: codes.includes('401'),
  };
}

const deref = (doc: OpenApiDoc, s: any): any => (s?.$ref ? deref(doc, resolvePointer(doc, s.$ref.slice(1)).node) : s);

function wrongType(type: string): unknown {
  switch (type) {
    case 'string':
      return 12345;
    case 'integer':
    case 'number':
      return 'not-a-number';
    case 'boolean':
      return 'not-a-boolean';
    case 'array':
      return 'not-an-array';
    case 'object':
      return 'not-an-object';
    default:
      return undefined;
  }
}

const typeOf = (s: any): string | undefined => (Array.isArray(s?.type) ? s.type.find((t: string) => t !== 'null') : s?.type);

/** Body cases: start from a VALID base payload and break exactly one rule per case. */
export function bodyCases(doc: OpenApiDoc, rawSchema: any, base: Record<string, unknown>, schemaName = 'body'): NegCase[] {
  const schema = deref(doc, rawSchema);
  if (!schema || typeOf(schema) !== 'object' && !schema.properties) return [];
  const cases: NegCase[] = [];
  const props: Record<string, any> = schema.properties ?? {};
  const required: string[] = schema.required ?? [];

  for (const r of required) {
    if (!(r in base)) continue;
    const { [r]: _omit, ...rest } = base;
    cases.push({ title: `missing required field "${r}"`, source: `${schemaName}.required`, data: rest });
  }

  for (const [name, raw] of Object.entries(props)) {
    const p = deref(doc, raw);
    if (!p || p.readOnly) continue;
    const t = typeOf(p);
    const at = `${schemaName}.${name}`;
    const withValue = (v: unknown) => ({ ...base, [name]: v });

    const wt = t ? wrongType(t) : undefined;
    if (wt !== undefined) cases.push({ title: `"${name}" has wrong type (${t} expected)`, source: `${at}.type`, data: withValue(wt) });

    if (t === 'string') {
      if (typeof p.minLength === 'number' && p.minLength > 0) cases.push({ title: `"${name}" shorter than minLength ${p.minLength}`, source: `${at}.minLength`, data: withValue('x'.repeat(p.minLength - 1)) });
      if (typeof p.maxLength === 'number') cases.push({ title: `"${name}" longer than maxLength ${p.maxLength}`, source: `${at}.maxLength`, data: withValue('x'.repeat(p.maxLength + 1)) });
    }
    if (t === 'number' || t === 'integer') {
      if (typeof p.minimum === 'number') cases.push({ title: `"${name}" below minimum ${p.minimum}`, source: `${at}.minimum`, data: withValue(p.minimum - 1) });
      if (typeof p.maximum === 'number') cases.push({ title: `"${name}" above maximum ${p.maximum}`, source: `${at}.maximum`, data: withValue(p.maximum + 1) });
    }
    if (Array.isArray(p.enum) && p.enum.length && t === 'string') {
      cases.push({ title: `"${name}" not in enum`, source: `${at}.enum`, data: withValue('__not_in_enum__') });
    }
    if ((t === 'number' || t === 'integer') && typeof p.exclusiveMinimum === 'number') {
      cases.push({ title: `"${name}" violates exclusiveMinimum ${p.exclusiveMinimum}`, source: `${at}.exclusiveMinimum`, data: withValue(p.exclusiveMinimum) });
    }
    if ((t === 'number' || t === 'integer') && typeof p.exclusiveMaximum === 'number') {
      cases.push({ title: `"${name}" violates exclusiveMaximum ${p.exclusiveMaximum}`, source: `${at}.exclusiveMaximum`, data: withValue(p.exclusiveMaximum) });
    }
    if (t === 'array' && typeof p.minItems === 'number' && p.minItems > 0) {
      cases.push({ title: `"${name}" has fewer than minItems ${p.minItems}`, source: `${at}.minItems`, data: withValue([]) });
    }
    if (t === 'array' && typeof p.maxItems === 'number') {
      const item = deref(doc, p.items);
      const sample = item?.example ?? (typeOf(item) === 'string' ? 'x' : typeOf(item) === 'number' || typeOf(item) === 'integer' ? 1 : undefined);
      if (sample !== undefined) cases.push({ title: `"${name}" has more than maxItems ${p.maxItems}`, source: `${at}.maxItems`, data: withValue(Array.from({ length: p.maxItems + 1 }, () => sample)) });
    }
  }

  if (schema.additionalProperties === false) {
    cases.push({ title: 'unknown field is rejected (additionalProperties: false)', source: `${schemaName}.additionalProperties`, data: { ...base, unexpectedField: 'api-agent' } });
  }
  if (typeof schema.minProperties === 'number' && schema.minProperties > 0) {
    cases.push({ title: `empty object (minProperties ${schema.minProperties})`, source: `${schemaName}.minProperties`, data: {} });
  }
  return cases.slice(0, MAX_CASES);
}

/** Query cases: break one documented query-parameter constraint per case. */
export function queryCases(op: Operation): NegCase[] {
  const cases: NegCase[] = [];
  const query = op.params.filter((p) => p.in === 'query');
  const valid: Record<string, unknown> = Object.fromEntries(query.filter((p) => p.required && p.knownValue !== undefined).map((p) => [p.name, p.knownValue]));

  for (const p of query) {
    const s = p.schema ?? {};
    const t = typeOf(s);
    const at = `query.${p.name}`;
    const withValue = (v: unknown) => ({ ...valid, [p.name]: v });
    if (p.required && p.name in valid) {
      const { [p.name]: _omit, ...rest } = valid;
      cases.push({ title: `missing required query "${p.name}"`, source: `${at}.required`, query: rest });
    }
    if (t === 'integer' || t === 'number') {
      cases.push({ title: `query "${p.name}" is not a number`, source: `${at}.type`, query: withValue('abc') });
      if (typeof s.minimum === 'number') cases.push({ title: `query "${p.name}" below minimum ${s.minimum}`, source: `${at}.minimum`, query: withValue(s.minimum - 1) });
      if (typeof s.maximum === 'number') cases.push({ title: `query "${p.name}" above maximum ${s.maximum}`, source: `${at}.maximum`, query: withValue(s.maximum + 1) });
    }
    if (t === 'integer' || t === 'number') {
      if (typeof s.exclusiveMinimum === 'number') cases.push({ title: `query "${p.name}" violates exclusiveMinimum ${s.exclusiveMinimum}`, source: `${at}.exclusiveMinimum`, query: withValue(s.exclusiveMinimum) });
      if (typeof s.exclusiveMaximum === 'number') cases.push({ title: `query "${p.name}" violates exclusiveMaximum ${s.exclusiveMaximum}`, source: `${at}.exclusiveMaximum`, query: withValue(s.exclusiveMaximum) });
    }
    if (t === 'string' && typeof s.minLength === 'number' && s.minLength > 0) cases.push({ title: `query "${p.name}" shorter than minLength ${s.minLength}`, source: `${at}.minLength`, query: withValue('x'.repeat(s.minLength - 1)) });
    if (t === 'boolean') cases.push({ title: `query "${p.name}" is not a boolean`, source: `${at}.type`, query: withValue('not-a-boolean') });
    if (t === 'string' && Array.isArray(s.enum) && s.enum.length) cases.push({ title: `query "${p.name}" not in enum`, source: `${at}.enum`, query: withValue('__not_in_enum__') });
    if (t === 'string' && typeof s.maxLength === 'number') cases.push({ title: `query "${p.name}" longer than maxLength ${s.maxLength}`, source: `${at}.maxLength`, query: withValue('x'.repeat(s.maxLength + 1)) });
  }
  return cases.slice(0, MAX_CASES);
}

/** A runtime expression (TypeScript source) for an id that should not exist, matching the param's schema. */
export function nonexistentIdExpr(schema: any): string {
  const t = typeOf(schema);
  if (schema?.format === 'uuid') return 'randomUUID()';
  if (t === 'integer' || t === 'number') return String(typeof schema?.maximum === 'number' ? schema.maximum : 2147483647);
  return '`nonexistent-${Date.now()}`';
}
