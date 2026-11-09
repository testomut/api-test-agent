import type { OpenApiDoc } from '../spec/loader.js';
import type { Operation } from '../types.js';
import type { CrudChain } from './graph.js';
import type { CoverageGap } from './body-cases.js';

/**
 * Documented error responses beyond 400 / 401 (missing credentials) / 404 / 422 (docs/SUPPORT_MATRIX.md, stage 6).
 * A case is generated only when the request that triggers the error is safe and its expectation is documented;
 * everything else is a gap with its reason. Nothing here guesses business rules.
 */

export interface ErrorPlan {
  /** 401 with a credential that is certainly invalid (per security scheme), sent without the real ones. */
  invalidCredentials?: { headers: Record<string, string>; params: Record<string, string> };
  /** 405: a GET to a path that defines no GET (the only method that is safe to send to an unknown route). */
  methodNotAllowed?: { method: 'get' };
  /** 415: the documented body sent as text/plain (create / update with confirmed cleanup). */
  unsupportedMediaType?: true;
  /** 412: a precondition header that cannot match, on a resource the test created. */
  preconditionFailed?: { header: string; value: string };
  /** 409: the same create payload twice, on fields a reviewed deps file names (conflictOn). */
  conflict?: { fields: string[] };
  /**
   * 401 / 403 with a credential a reviewed deps file names by its environment variable ("auth"): an expired one
   * (401) or a valid one of an account that must be refused (403). The test is skipped when the variable is unset.
   */
  envCredentials?: EnvCredential[];
  gaps: CoverageGap[];
}

export interface EnvCredential {
  kind: 'expired' | 'forbidden';
  status: '401' | '403';
  env: string;
  /** Where the credential goes: a header (with a prefix such as "Bearer ") or a query parameter. */
  header?: string;
  query?: string;
  prefix: string;
  /** forbidden: the documented path values are used (a missing resource must not answer before the refusal). */
  knownPath: boolean;
}

/** deps file "auth": credentials the reviewer provides through environment variables (never in the file). */
export interface AuthConfig {
  forbidden?: { credentialEnv: string; operations: string[] };
  expired?: { credentialEnv: string };
}

/** Checks a deps "auth" section against the spec; problems are INVALID_REVIEWED_CONFIG gaps of the operation named. */
export function checkAuthConfig(auth: AuthConfig | undefined, ops: Operation[]): string[] {
  if (!auth) return [];
  const errors: string[] = [];
  const envName = /^[A-Z][A-Z0-9_]*$/;
  if (auth.forbidden) {
    if (!envName.test(String(auth.forbidden.credentialEnv))) errors.push('auth.forbidden.credentialEnv must name an environment variable (e.g. API_FORBIDDEN_TOKEN)');
    for (const id of auth.forbidden.operations ?? []) if (!ops.some((o) => o.operationId === id)) errors.push(`auth.forbidden: operation "${id}" is not in the spec`);
  }
  if (auth.expired && !envName.test(String(auth.expired.credentialEnv))) errors.push('auth.expired.credentialEnv must name an environment variable (e.g. API_EXPIRED_TOKEN)');
  return errors;
}

/** Where a credential of the operation's (single) security scheme goes. */
function placement(doc: OpenApiDoc, op: Operation): { header?: string; query?: string; prefix: string } | string {
  const req = op.security[0] ?? [];
  if (req.length !== 1) return req.length ? 'several schemes must be satisfied together' : 'the operation needs no credentials';
  const s = (doc as any).components?.securitySchemes?.[req[0]];
  const type = String(s?.type ?? '').toLowerCase();
  if (type === 'http' && String(s.scheme).toLowerCase() === 'bearer') return { header: 'Authorization', prefix: 'Bearer ' };
  if (type === 'oauth2' || type === 'openidconnect') return { header: 'Authorization', prefix: 'Bearer ' };
  if (type === 'apikey' && s.in === 'header') return { header: s.name, prefix: '' };
  if (type === 'apikey' && s.in === 'query') return { query: s.name, prefix: '' };
  return `security scheme "${req[0]}" (${type || 'unknown'}) takes no single token`;
}

const INVALID_TOKEN = 'api-agent-invalid-token';
const PRECONDITION_VALUES: Record<string, string> = {
  'if-match': '"api-agent-no-such-etag"',
  'if-unmodified-since': 'Thu, 01 Jan 1970 00:00:00 GMT',
};
/** Statuses with a handler in this module or elsewhere in the generator. */
const HANDLED = new Set(['400', '401', '403', '404', '405', '409', '412', '415', '422', '429', '4XX']);

export interface ErrorInput {
  doc: OpenApiDoc;
  op: Operation;
  ops: Operation[];
  chain?: CrudChain;
  role?: 'create' | 'read' | 'update' | 'delete';
  hasUpdatePayload: boolean;
  /** Write requests may be sent only with a confirmed cleanup (or for safe methods). */
  reachable: boolean;
  /** The operation is the first one of its path documenting 405 (one case per path). */
  firstWith405: boolean;
  /** Reviewed deps "auth" section. */
  auth?: AuthConfig;
}

export function errorPlan(i: ErrorInput): ErrorPlan {
  const { doc, op } = i;
  const plan: ErrorPlan = { gaps: [] };
  const codes = new Set(op.responses.map((r) => r.status.toUpperCase()));
  const gap = (code: string, status: string, reason: string) => plan.gaps.push({ code, location: `response.status#/${status}`, reason });

  // 401: an invalid credential of the scheme the operation uses.
  if (codes.has('401') && i.reachable && op.security.length && !op.security.some((a) => a.length === 0)) {
    const schemes = (doc as any).components?.securitySchemes ?? {};
    const headers: Record<string, string> = {};
    const params: Record<string, string> = {};
    let unknown: string | undefined;
    for (const name of op.security[0]) {
      const s = schemes[name];
      const type = String(s?.type ?? '').toLowerCase();
      if (type === 'http' && String(s.scheme).toLowerCase() === 'basic') headers.Authorization = `Basic ${Buffer.from('api-agent:invalid').toString('base64')}`;
      else if (type === 'http' || type === 'oauth2' || type === 'openidconnect') headers.Authorization = `Bearer ${INVALID_TOKEN}`;
      else if (type === 'apikey' && s.in === 'header') headers[s.name] = 'api-agent-invalid-key';
      else if (type === 'apikey' && s.in === 'query') params[s.name] = 'api-agent-invalid-key';
      else if (type === 'apikey' && s.in === 'cookie') headers.Cookie = `${s.name}=api-agent-invalid-key`;
      else unknown = name;
    }
    if (unknown) gap('UNSUPPORTED_SCHEMA_KEYWORD', '401', `security scheme "${unknown}" has no known invalid credential`);
    else plan.invalidCredentials = { headers, params };
  }

  // 405: only a GET may be sent to an undocumented method of a path.
  if (codes.has('405') && i.firstWith405) {
    const defined = new Set(i.ops.filter((o) => o.path === op.path).map((o) => o.method));
    if (!defined.has('get')) plan.methodNotAllowed = { method: 'get' };
    else gap('UNSAFE_LIVE_CHECK', '405', `every undocumented method of ${op.path} could change data if the API implements it`);
  }

  // 415: the body as text/plain, where a created resource can be cleaned up.
  if (codes.has('415')) {
    if (!op.hasRequestBody) gap('UNREACHABLE_RESPONSE_STATUS', '415', 'the operation has no request body');
    else if (i.role === 'create' || (i.role === 'update' && i.hasUpdatePayload)) plan.unsupportedMediaType = true;
    else gap('MISSING_CLEANUP', '415', 'a write without a confirmed precondition and cleanup is not sent');
  }

  // 412: a precondition header that cannot match, on the test's own resource.
  if (codes.has('412')) {
    const header = op.params.find((p) => p.in === 'header' && PRECONDITION_VALUES[p.name.toLowerCase()]);
    if (!header) gap('UNCONFIRMED_BUSINESS_RULE', '412', 'no If-Match / If-Unmodified-Since header is documented to trigger it');
    else if ((i.role === 'update' && i.hasUpdatePayload) || i.role === 'delete') plan.preconditionFailed = { header: header.name, value: PRECONDITION_VALUES[header.name.toLowerCase()] };
    else gap('MISSING_CLEANUP', '412', 'needs a resource the test creates and removes (a confirmed update / delete chain)');
  }

  // 409: duplicate create, only on fields a reviewed deps file names.
  if (codes.has('409')) {
    if (i.role === 'create' && i.chain?.conflictOn?.length) plan.conflict = { fields: i.chain.conflictOn };
    else gap('UNCONFIRMED_BUSINESS_RULE', '409', i.role === 'create' ? 'which fields conflict is not confirmed: add "conflictOn" to the deps file' : 'what makes this operation conflict is not documented');
  }

  // 401 with an expired credential (deps auth.expired): the same safe request as the invalid-credential case.
  const envCredentials: EnvCredential[] = [];
  if (i.auth?.expired && plan.invalidCredentials) {
    const at = placement(doc, op);
    if (typeof at === 'string') gap('UNSUPPORTED_SCHEMA_KEYWORD', '401', `expired credential: ${at}`);
    else envCredentials.push({ kind: 'expired', status: '401', env: i.auth.expired.credentialEnv, ...at, knownPath: false });
  }
  // 403 with a valid credential of an account that must be refused (deps auth.forbidden), for the operations named.
  const listed = !!op.operationId && (i.auth?.forbidden?.operations ?? []).includes(op.operationId);
  if (listed && !codes.has('403')) plan.gaps.push({ code: 'INVALID_REVIEWED_CONFIG', location: 'request.security', reason: `deps auth.forbidden names ${op.operationId}, but it documents no 403` });
  if (codes.has('403')) {
    const at = placement(doc, op);
    const unknownPath = op.params.filter((p) => p.in === 'path' && p.knownValue === undefined);
    if (!listed) gap('UNCONFIRMED_BUSINESS_RULE', '403', 'needs a reviewed role / scope configuration: deps "auth.forbidden" (an account that must be refused)');
    else if (!['get', 'head'].includes(op.method)) gap('UNSAFE_LIVE_CHECK', '403', 'a write with an account that must be refused could still change data if the API lets it through');
    else if (unknownPath.length) gap('MISSING_RESOURCE_SOURCE', '403', `no value for ${unknownPath.map((p) => `path "${p.name}"`).join(', ')}: a missing resource could answer before the refusal`);
    else if (typeof at === 'string') gap('UNSUPPORTED_SCHEMA_KEYWORD', '403', at);
    else envCredentials.push({ kind: 'forbidden', status: '403', env: i.auth!.forbidden!.credentialEnv, ...at, knownPath: true });
  }
  if (envCredentials.length) plan.envCredentials = envCredentials;
  if (codes.has('429')) gap('UNSAFE_LIVE_CHECK', '429', 'rate limiting is not exercised (it would load the target)');
  for (const c of codes) if (/^4\d\d$/.test(c) && !HANDLED.has(c)) gap('UNREACHABLE_RESPONSE_STATUS', c, `no deterministic request triggers ${c}`);
  return plan;
}
