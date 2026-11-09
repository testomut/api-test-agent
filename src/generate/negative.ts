import type { Operation } from '../types.js';
import { resolvePointer, type OpenApiDoc } from '../spec/loader.js';
import type { ARRAY } from '../cases/ids.js';
import { bodyCasesDetailed } from './body-cases.js';

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
  /** What the case breaks, for its case ID: a body field (path from the root; [] = the body) or a parameter, and the rule. */
  target?: { in: 'body'; path: (string | typeof ARRAY)[]; rule: string } | { in: 'query'; field: string | null; rule: string };
}

/** Derives the target of a query case from its source ("query.<name>.<rule>"). */
function withTargets(cases: NegCase[], prefix: string): NegCase[] {
  return cases.map((c) => {
    const rest = c.source.startsWith(prefix + '.') ? c.source.slice(prefix.length + 1) : c.source;
    const dot = rest.lastIndexOf('.');
    return { ...c, target: { in: 'query' as const, field: dot < 0 ? null : rest.slice(0, dot), rule: dot < 0 ? rest : rest.slice(dot + 1) } };
  });
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

/** Body cases: start from a VALID base payload and break exactly one rule per case, at any depth (see body-cases.ts). */
export function bodyCases(doc: OpenApiDoc, rawSchema: any, base: Record<string, unknown>, schemaName = "body", maxCases?: number): NegCase[] {
  return bodyCasesDetailed(doc, rawSchema, base, schemaName, maxCases).cases;
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
  return withTargets(cases.slice(0, MAX_CASES), 'query');
}

/** A runtime expression (TypeScript source) for an id that should not exist, matching the param's schema. */
export function nonexistentIdExpr(schema: any): string {
  const t = typeOf(schema);
  if (schema?.format === 'uuid') return 'randomUUID()';
  if (t === 'integer' || t === 'number') return String(typeof schema?.maximum === 'number' ? schema.maximum : 2147483647);
  return '`nonexistent-${Date.now()}`';
}
