import { createHash } from 'node:crypto';
import { base32 } from '../change/normalize.js';

/**
 * Case IDs (docs/OPENAPI_CHANGE_TRIGGER.md, "Case ID format"):
 *   ata:<subjectUid>:<suiteType>:<polarity>:<location>:<rule>
 * The colon separates the six parts; dynamic names are percent-encoded so they never contain one.
 */

export type SuiteType = 'functional' | 'contract' | 'scenario';
export type Polarity = 'positive' | 'negative';

/** v2 adds functional/positive `accepted-value` (one case per documented parameter value). Registries of v1 stay readable. */
export const CASE_RULE_VOCABULARY_VERSION = 2;

const CONSTRAINT_RULES = [
  'required', 'nullable', 'type', 'format', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'enum', 'const', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'additionalProperties',
] as const;

/** Built-in vocabulary v1, by suiteType/polarity. */
export const VOCABULARY_V1: Record<string, readonly string[]> = {
  'functional/positive': ['documented-success', 'accepted-value'],
  'functional/negative': ['not-found', 'unauthorized', 'forbidden'],
  'contract/positive': ['documented', 'schema'],
  'contract/negative': [...CONSTRAINT_RULES, 'content-type'],
  'scenario/positive': ['crud', 'business-rule'],
  'scenario/negative': ['business-rule'],
};

/**
 * Canonical encoding of one dynamic name / JSON pointer segment (after RFC 6901 escaping):
 * % → %25, : → %3A, a literal * → %2A, control / non-ASCII / other disallowed → uppercase UTF-8 percent-encoding.
 */
export function encodeName(name: string): string {
  let out = '';
  for (const ch of name) {
    if (/^[A-Za-z0-9\-._~!$&'()+,;=@]$/.test(ch)) out += ch;
    else out += [...Buffer.from(ch, 'utf8')].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
  }
  return out;
}

/** A JSON pointer segment of a case location: RFC 6901 escaping, then the canonical percent-encoding. */
export const encodeSegment = (name: string) => encodeName(name.replace(/~/g, '~0').replace(/\//g, '~1'));

/** Body / response field pointer from raw property names; ARRAY marks an array element (a bare `*`). */
export const ARRAY = Symbol('array element');
export function bodyPointer(segments: (string | typeof ARRAY)[]): string {
  return segments.map((s) => '/' + (s === ARRAY ? '*' : encodeSegment(s))).join('');
}

export const location = {
  operation: () => 'operation',
  lifecycle: () => 'lifecycle',
  security: () => 'request.security',
  requestContentType: () => 'request.content-type',
  query: (name: string) => `request.query#/${encodeSegment(name)}`,
  path: (name: string) => `request.path#/${encodeSegment(name)}`,
  /** One documented value of a parameter: `request.query#/<name>/<value>` (string, number or boolean as in the spec). */
  paramValue: (where: 'query' | 'path' | 'header' | 'cookie', name: string, value: string | number | boolean) =>
    `request.${where}#/${encodeSegment(where === 'header' ? name.toLowerCase() : name)}/${encodeSegment(String(value))}`,
  header: (name: string) => `request.header#/${encodeSegment(name.toLowerCase())}`,
  cookie: (name: string) => `request.cookie#/${encodeSegment(name)}`,
  /** `pointer` is already a case pointer ('' = body root). */
  requestBody: (pointer: string) => `request.body#${pointer}`,
  responseBody: (pointer: string) => `response.body#${pointer}`,
  status: (status: string) => `response.status#/${encodeSegment(status)}`,
  responseContentType: (mediaType: string) => `response.content-type#/${encodeSegment(mediaType)}`,
};

export interface CaseParts {
  subjectUid: string;
  suiteType: SuiteType;
  polarity: Polarity;
  location: string;
  rule: string;
}

export const caseId = (p: CaseParts) => `ata:${p.subjectUid}:${p.suiteType}:${p.polarity}:${p.location}:${p.rule}`;

export interface CaseIdError {
  code: 'INVALID_CASE_ID' | 'INVALID_CASE_ID_ENCODING' | 'INVALID_CASE_SUBJECT' | 'INVALID_CASE_RULE' | 'INVALID_CASE_RULE_FOR_SUITE' | 'INVALID_CASE_LOCATION';
  reason: string;
}

const UID = /^(op|scn)_[A-Z2-7]{12,52}$/;
const LOCATION = /^(operation|lifecycle|request\.security|request\.content-type|request\.(query|path|header|cookie)#\/[^/]*(\/[^/]*)?|request\.body#(\/[^/]*)*|response\.body#(\/[^/]*)*|response\.status#\/[^/]+|response\.content-type#\/[^/]+)$/;

/** Splits on the five structural colons and checks encoding, vocabulary and the allowed combination (no spec needed). */
export function parseCaseId(id: string): { ok: true; parts: CaseParts } | { ok: false; error: CaseIdError } {
  const fail = (code: CaseIdError['code'], reason: string) => ({ ok: false as const, error: { code, reason } });
  const raw = id.split(':');
  if (raw.length !== 6) return fail(raw.length > 6 ? 'INVALID_CASE_ID_ENCODING' : 'INVALID_CASE_ID', `${id}: expected 6 parts separated by ":", got ${raw.length} (an unencoded ":" inside a name?)`);
  const [prefix, subjectUid, suiteType, polarity, loc, rule] = raw;
  if (prefix !== 'ata') return fail('INVALID_CASE_ID', `${id}: must start with "ata:"`);
  if (/%(?![0-9A-F]{2})/.test(loc)) return fail('INVALID_CASE_ID_ENCODING', `${id}: "%" must be "%25" and escapes uppercase (e.g. %3A, not %3a)`);
  if (!UID.test(subjectUid)) return fail('INVALID_CASE_SUBJECT', `${id}: subject must be an op_ or scn_ UID`);
  if (!['functional', 'contract', 'scenario'].includes(suiteType)) return fail('INVALID_CASE_ID', `${id}: unknown suite type "${suiteType}"`);
  if (!['positive', 'negative'].includes(polarity)) return fail('INVALID_CASE_ID', `${id}: unknown polarity "${polarity}"`);
  if (!LOCATION.test(loc)) return fail('INVALID_CASE_LOCATION', `${id}: location "${loc}" is not a known form`);
  const parts: CaseParts = { subjectUid, suiteType: suiteType as SuiteType, polarity: polarity as Polarity, location: loc, rule };
  const combo = checkCombination(parts);
  return combo ? { ok: false, error: { ...combo, reason: `${id}: ${combo.reason}` } } : { ok: true, parts };
}

/** The allowed suiteType / polarity / location / rule combinations of vocabulary v1. Custom rules: x-<namespace>-<rule>. */
export function checkCombination(p: CaseParts): CaseIdError | undefined {
  if (/^x-[a-z0-9]+-[a-z0-9-]+$/.test(p.rule)) return undefined;
  const allowed = VOCABULARY_V1[`${p.suiteType}/${p.polarity}`] ?? [];
  const known = Object.values(VOCABULARY_V1).some((rules) => rules.includes(p.rule));
  if (!known) return { code: 'INVALID_CASE_RULE', reason: `unknown rule "${p.rule}" (custom rules are x-<namespace>-<rule>)` };
  if (!allowed.includes(p.rule)) return { code: 'INVALID_CASE_RULE_FOR_SUITE', reason: `rule "${p.rule}" is not allowed for ${p.suiteType}/${p.polarity}` };
  const loc = p.location;
  const bad = (why: string): CaseIdError => ({ code: 'INVALID_CASE_LOCATION', reason: why });
  const subject = (why: string): CaseIdError => ({ code: 'INVALID_CASE_SUBJECT', reason: why });
  switch (`${p.suiteType}/${p.polarity}`) {
    case 'functional/positive':
      if (p.rule === 'accepted-value') return /^request\.(query|path|header|cookie)#\/[^/]*\/[^/]*$/.test(loc) ? undefined : bad('accepted-value names a parameter and its value: request.<in>#/<name>/<value>');
      return loc === 'operation' ? undefined : bad(`documented-success is checked on "operation", not "${loc}"`);
    case 'functional/negative':
      if (p.rule === 'not-found') return /^request\.path#\/[^/]*$/.test(loc) ? undefined : bad('not-found is checked on a path parameter');
      return loc === 'request.security' ? undefined : bad(`${p.rule} is checked on "request.security"`);
    case 'contract/positive':
      if (p.rule === 'schema') return loc.startsWith('response.body#') ? undefined : bad('schema is checked on a response body location');
      return loc.startsWith('response.status#/') || loc.startsWith('response.content-type#/') ? undefined : bad('documented is checked on a response status or content type');
    case 'contract/negative':
      if (p.rule === 'content-type') return loc === 'request.content-type' ? undefined : bad('content-type is checked on "request.content-type"');
      return /^request\.body#/.test(loc) || /^request\.(query|path|header|cookie)#\/[^/]*$/.test(loc) ? undefined : bad('a constraint rule is checked on a request field or one parameter');
    default: // scenario
      if (loc === 'lifecycle') return p.subjectUid.startsWith('scn_') ? undefined : subject('a lifecycle scenario needs a scn_ subject');
      if (loc === 'operation' && p.polarity === 'negative' && p.rule === 'business-rule') return p.subjectUid.startsWith('op_') ? undefined : subject('a single-operation scenario needs an op_ subject');
      return bad(`scenario cases use "lifecycle"${p.polarity === 'negative' ? ' (or "operation" for a single-operation business rule)' : ''}`);
  }
}

export type Phase = 'setup' | 'action' | 'assertion' | 'cleanup';
export interface ScenarioStep {
  operationUid: string;
  phase: Phase;
}

/** scenarioUid without an external ID: scn_ + base32(sha256("type=<t>;steps=<phase>:<uid>>…"))[0:12]. */
export function scenarioUid(scenarioType: 'crud' | 'business', steps: ScenarioStep[], externalId?: string, length = 12): string {
  const input = externalId !== undefined ? `id=${externalId}` : `type=${scenarioType};steps=${steps.map((s) => `${s.phase}:${s.operationUid}`).join('>')}`;
  return 'scn_' + base32(createHash('sha256').update(input).digest()).slice(0, length);
}
