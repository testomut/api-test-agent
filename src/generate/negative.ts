import type { Operation } from '../types.js';
import { resolvePointer, type OpenApiDoc } from '../spec/loader.js';
import type { ARRAY } from '../cases/ids.js';
import { bodyCasesDetailed } from './body-cases.js';
import type { ParamRequest } from './param-cases.js';

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
  target?: { in: 'body'; path: (string | typeof ARRAY)[]; rule: string } | { in: 'query' | 'header' | 'cookie' | 'path'; field: string | null; rule: string };
  /** Parameter cases: the whole request (valid parameters plus the one under test). */
  request?: ParamRequest;
}



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


/** A runtime expression (TypeScript source) for an id that should not exist, matching the param's schema. */
export function nonexistentIdExpr(schema: any): string {
  const t = typeOf(schema);
  if (schema?.format === 'uuid') return 'randomUUID()';
  if (t === 'integer' || t === 'number') return String(typeof schema?.maximum === 'number' ? schema.maximum : 2147483647);
  return '`nonexistent-${Date.now()}`';
}
