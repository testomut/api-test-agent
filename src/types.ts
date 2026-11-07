export type HttpMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';

export const HTTP_METHODS: HttpMethod[] = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
export const SAFE_METHODS: HttpMethod[] = ['get', 'head', 'options'];

/** Result vocabulary from the plan. PASS never means "the whole endpoint is covered". */
export type Status = 'PASS' | 'CONTRACT_MISMATCH' | 'TEST_FAILURE' | 'BLOCKED' | 'NOT_RUN';

export interface ParamInfo {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  /** A concrete value the spec itself provides (example / default / first enum). */
  knownValue?: unknown;
  schema?: Record<string, unknown>;
}

export interface ResponseInfo {
  status: string; // "200", "4XX", "default"
  contentTypes: string[];
  hasSchema: boolean;
}

export interface Operation {
  key: string; // "GET /items/{id}"
  method: HttpMethod;
  path: string;
  operationId?: string;
  summary?: string;
  deprecated: boolean;
  params: ParamInfo[];
  hasRequestBody: boolean;
  requestBodyRequired: boolean;
  requestContentTypes: string[];
  responses: ResponseInfo[];
  /** Names of security schemes this operation needs (any one alternative satisfied = OK). */
  security: string[][];
  /** Why this operation cannot be checked as-is. Deterministic, no guessing. */
  testabilityIssues: string[];
}

export interface Finding {
  operation: string;
  source: 'probe' | 'schemathesis' | 'generate';
  status: Status;
  reason: string;
  details?: unknown;
}

export interface LintProblem {
  ruleId: string;
  severity: 'error' | 'warn';
  message: string;
  pointer?: string;
}
