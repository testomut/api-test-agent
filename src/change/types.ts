/**
 * Types of the semantic OpenAPI diff (docs/OPENAPI_CHANGE_TRIGGER.md, "Change kinds").
 * changes.json is validated by schemas/changes.schema.json.
 */

export type ChangeKind =
  | 'operation-added'
  | 'operation-removed'
  | 'operation-moved' // path changed (candidate unless confirmed)
  | 'operationId-renamed' // same method + normalized path, new operationId
  | 'stable-id-changed' // needs the case registry: not emitted yet
  | 'parameter-changed'
  | 'parameter-renamed' // {id} → {brandId}: zero contract change, matters for codegen
  | 'request-changed'
  | 'response-changed'
  | 'schema-constraint-changed'
  | 'example-changed' // example / default changed: non-breaking, test-relevant when used for payloads
  | 'servers-changed' // reported, never regenerates cases
  | 'retired-operation-reappeared'; // needs the case registry: not emitted yet

/** Schema facets: the negative rules of the vocabulary that describe a schema keyword. */
export type Facet =
  | 'required'
  | 'nullable'
  | 'type'
  | 'format'
  | 'pattern'
  | 'minimum'
  | 'maximum'
  | 'exclusiveMinimum'
  | 'exclusiveMaximum'
  | 'multipleOf'
  | 'minLength'
  | 'maxLength'
  | 'enum'
  | 'const'
  | 'minItems'
  | 'maxItems'
  | 'uniqueItems'
  | 'minProperties'
  | 'maxProperties'
  | 'additionalProperties';

export type Breaking = 'yes' | 'no' | 'unknown';

export interface OpenApiChange {
  kind: ChangeKind;
  operationUid: string;
  operationKey: string; // METHOD + path, for humans
  pointer?: string; // JSON Pointer to the changed component
  scope?: 'request' | 'response';
  facet?: Facet; // schema-constraint-changed only
  before?: unknown;
  after?: unknown;
  breaking: Breaking; // compatibility verdict (from oasdiff)
  testRelevant: boolean; // whether existing or generated tests are affected
  confidence?: number; // rename / move detection only
  /** Move detection only: the link is a candidate a human must confirm (score 0.70–0.89, or no clear lead). */
  review?: boolean;
  /** Human-readable explanation. */
  note?: string;
}

export interface BlockedResult {
  code: string; // e.g. BASE_SPEC_MISSING, OASDIFF_UNSUPPORTED_CONSTRUCT, DUPLICATE_API_TEST_AGENT_ID
  pointers?: string[];
  reason: string;
}

export type BaseSource = 'flag' | 'merge-base' | 'ci-artifact' | 'snapshot';

export interface OpenApiChangeSet {
  baseRevision: string;
  headRevision: string;
  baseSource: BaseSource | null; // null when no baseline was found (BASE_SPEC_MISSING)
  engine: { name: 'oasdiff'; version: string; versionMismatch: boolean };
  changes: OpenApiChange[];
  blocked: BlockedResult[];
}

export type FailOn = 'breaking' | 'blocked' | 'unknown' | 'never';

/** The command cannot run correctly (exit code 2): configuration or runtime error, never an analysis result. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
