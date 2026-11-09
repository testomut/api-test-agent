import type { Operation } from '../types.js';
import type { CoverageGap } from './body-cases.js';
import type { ErrorPlan } from './error-cases.js';

/**
 * Coverage report helpers (docs/SUPPORT_MATRIX.md, stage 10): machine codes for every reason a check is missing,
 * and what the generated suite leaves unchecked per operation.
 */

/** Stable machine codes. A new reason gets a new code; a code is never renamed. */
export const GAP_CODES = [
  'MISSING_VALID_SAMPLE',
  'MISSING_RESOURCE_SOURCE',
  'MISSING_CLEANUP',
  'MISSING_RESPONSE_SCHEMA',
  'UNSUPPORTED_SCHEMA_KEYWORD',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNCONFIRMED_BUSINESS_RULE',
  'UNCOVERED_VARIANT',
  'CANNOT_ISOLATE_RULE',
  'CASE_LIMIT_REACHED',
  'UNREACHABLE_RESPONSE_STATUS',
  'UNSAFE_LIVE_CHECK',
  'DEPRECATED_OPERATION',
  'NO_DOCUMENTED_REJECTION',
] as const;

/** The code behind a positive-blocked reason the generator writes in prose. */
export function positiveCode(reason: string | undefined): string | null {
  if (!reason) return null;
  if (/deprecated/i.test(reason)) return 'DEPRECATED_OPERATION';
  if (/ends the session/i.test(reason)) return 'UNSAFE_LIVE_CHECK';
  if (/no confirmed precondition\/cleanup|cleaned up|No delete operation/i.test(reason)) return 'MISSING_CLEANUP';
  if (/No example-backed payload|Cannot build a valid|cannot derive/i.test(reason)) return 'MISSING_VALID_SAMPLE';
  if (/No concrete 2xx/i.test(reason)) return 'UNREACHABLE_RESPONSE_STATUS';
  if (/candidate|unconfirmed|Confirm|link the operation/i.test(reason)) return 'MISSING_RESOURCE_SOURCE';
  if (/No value for|spec example|with no value/i.test(reason)) return 'MISSING_RESOURCE_SOURCE';
  return 'UNCONFIRMED_BUSINESS_RULE';
}

export interface Exercised {
  positive: boolean;
  notFound: boolean;
  unauthorized: boolean;
  validation: string[]; // statuses expected by body / parameter cases
  invalidInput: boolean; // there are body / parameter cases
  errors?: ErrorPlan;
  deleteTwice: boolean;
}

/** Documented statuses no generated test exercises (2xx counts as exercised by the success call). */
export function uncheckedStatuses(op: Operation, x: Exercised): { status: string; code: string }[] {
  const hit = new Set<string>();
  if (x.positive) for (const r of op.responses) if (/^2/.test(r.status)) hit.add(r.status);
  if (x.notFound || x.deleteTwice) hit.add('404');
  if (x.unauthorized || x.errors?.invalidCredentials) hit.add('401');
  if (x.invalidInput) for (const v of x.validation) hit.add(v.toUpperCase());
  if (x.errors?.methodNotAllowed) hit.add('405');
  if (x.errors?.conflict) hit.add('409');
  if (x.errors?.preconditionFailed) hit.add('412');
  if (x.errors?.unsupportedMediaType) hit.add('415');
  // The precise reason when an error gap names this status; otherwise a code by status class.
  const reason = (status: string) => x.errors?.gaps.find((g) => g.location === `response.status#/${status}`)?.code;
  return op.responses
    .filter((r) => !hit.has(r.status.toUpperCase()))
    .map((r) => ({ status: r.status, code: reason(r.status) ?? (/^(5|default)/i.test(r.status) ? 'UNREACHABLE_RESPONSE_STATUS' : /^4/.test(r.status) ? 'NO_DOCUMENTED_REJECTION' : 'UNCONFIRMED_BUSINESS_RULE') }));
}

/** Request media types the suite never sends (it sends JSON), and security alternatives beyond the one it uses. */
export function uncheckedRequest(op: Operation): { contentTypes: string[]; securityAlternatives: string[][] } {
  const json = op.requestContentTypes.find((c) => c.toLowerCase().includes('json'));
  return {
    contentTypes: op.requestContentTypes.filter((c) => c !== json),
    securityAlternatives: op.security.length > 1 ? op.security.slice(1) : [],
  };
}

/** Totals by code across operations. */
export function summarize(ops: { gaps: CoverageGap[]; positiveBlockedCode?: string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of ops) {
    for (const g of o.gaps) out[g.code] = (out[g.code] ?? 0) + 1;
    if (o.positiveBlockedCode) out[o.positiveBlockedCode] = (out[o.positiveBlockedCode] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
