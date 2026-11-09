# OpenAPI change-triggered incremental generation (design)

Status: **partly implemented**. Steps 1 (`diff`, #10) and 2 (the three-file suite layout, #3) of the [implementation order](#implementation-order) are done, and the core of step 3 (case IDs, `cases.json`, generation manifest, snapshot metadata, `registry validate`, `manifest validate`, #11). Not implemented: `registry merge`, ID aliases input, `plan`, `--apply-generated`, CI examples. See [Current generator](#current-generator) for what the design can rely on today.

## Goal

When an OpenAPI specification changes in a pull request, CI should identify *semantic* changes and propose only the relevant test updates. Never silently rewrite assertions to match a new spec.

## Pipeline

1. A repository webhook starts CI on a PR; CI uses a path filter for OpenAPI files (and an explicit manual trigger for non-file specs). The pipeline is CI-agnostic; see [CI integration](#ci-integration).
2. Obtain the **baseline** spec (see [Baseline](#baseline)) and the PR's spec. Resolve references and normalize both (see [Normalization](#normalization)); match operations by stable `operationUid`, not by `operationId`.
3. Emit a machine-readable `OpenApiChangeSet`: added/removed/moved operations, request parameter/body changes, response status/schema changes, constraint changes, example changes, and a compatibility verdict per change. Renames are tracked separately (see [Rename detection](#rename-detection)).
4. Map changes to stable case IDs (see [Stable IDs](#stable-ids)). Include dependent scenarios using the dependency graph; distinguish confirmed edges (OpenAPI links/reviewed deps) from candidates. Tests without a case ID are reported as [untracked](#untracked-tests).
5. Produce a **review-only** test plan and proposed test file changes. If existing tests already cover the change, report that instead of regenerating. Never delete or rewrite existing assertions automatically (see [Generated vs. hand-written files](#generated-vs-hand-written-files) for the only exception).
6. Publish report artifacts and optionally open a draft PR for human review. The agent should not push changes back to the triggering PR by default.

## Current generator

What `generate` does today (api-test-agent `main`, November 2026), and what the change trigger builds on:

| Feature | State | Relevance to this design |
|---|---|---|
| Three files per operation: `functional` / `contract` / `scenarios`, polarity as a tag (`@positive` / `@negative`, pytest markers), no empty files | implemented (#3) | the target [test suite layout](#test-suite-layout); `plan` maps impact onto these files |
| Removal of generated files of the old `positive` / `negative` layout and of stale suite files, header-checked | implemented (#3) | a narrow, existing case of "generated files may be changed"; the [manifest](#case-registry-and-generation-manifest) replaces the header check later |
| Scenarios: create → read (under create), update → read (under update), delete → read 404 (under delete) | implemented (#3, #5) | each lives under its primary operation, as [below](#test-suite-layout) |
| GET cases for each `enum` value of a query parameter; rejection cases for `exclusiveMinimum` / `exclusiveMaximum`, `minItems`, query `minLength` | implemented (#5) | a change of these facets is test-relevant (`schema-constraint-changed`) |
| `coverage-gaps.json` next to the report: cases per suite per operation and why a side is missing | implemented (#5) | a starting point for `SuiteImpact` (`no-change` / `blocked` with the reason) |
| Unique suffix for plain string fields when create / update documents `409` | implemented (#6) | adding or removing a documented `409`, or a field's `enum` / `format` / `pattern`, changes the generated payload: test-relevant |
| Cleanup that cannot remove a record is reported (`WARNING`, report table); a failed create check removes the record first | implemented (#7, #9) | — |
| `deps.json` `fill`: a create body field read from existing data at run time (`{ "from": "<GET operationId>", "pointer": "/data/0/id" }`) | implemented (#8) | [dependency graph validation](#dependency-graph-impact) must cover `fill` sources too |
| Stale `_support/*.resource.ts` / `*_resource.py` removed, header-checked | implemented (#8) | — |
| `diff` with oasdiff 1.34.1, deterministic `operationUid`, rename detection | implemented (#10) | step 1 |
| Case IDs on every generated test, `_support/cases.json`, `generation-manifest.json`, `openapi.snapshot.meta.json` (snapshot as a `diff` baseline), `registry validate`, `manifest validate` | implemented (#11) | core of step 3 |
| `registry merge`, `--id-aliases` / `--apply-registry`, `plan`, `--apply-generated`, CI examples | not implemented | rest of step 3, steps 4–6 |

## Test suite layout

> **Implemented.** The generator writes this structure since #3 (step 2 of the [implementation order](#implementation-order)); `generate` removes the generated `positive` / `negative` files of the old layout. Case IDs and the scenario registry referenced below are not implemented yet: today the scenario's primary operation is derived from its CRUD role (create → read under create, update → read under update, delete → read 404 under delete).

Every API endpoint (operation folder) gets up to three test files, one per **suite type**:

```text
tests/api/
└── orders/
    └── patch-by-id/
        ├── functional.spec.ts
        ├── contract.spec.ts
        └── scenarios.spec.ts
```

The operation folder keeps the current generator's naming (`<resource>/<method>` or `<resource>/<method>-by-id`). Python uses `test_functional.py`, `test_contract.py` and `test_scenarios.py` in the same folders.

| Suite type | File | Purpose |
|---|---|---|
| `functional` | `functional.spec.ts` | Normal work of the endpoint: the request, the expected HTTP status, the result and basic functional behavior. |
| `contract` | `contract.spec.ts` | Conformance to Swagger/OpenAPI: documented statuses and content types, response structure, types, required fields and schema constraints. |
| `scenario` | `scenarios.spec.ts` | User and business scenarios: request chains, preconditions, state changes, business rules and cleanup. |

**Positive/negative is not a file type.** It is a separate axis, **polarity**: positive and negative cases can live in each of the three files.

Default mapping of checks:

| Check | Suite type / polarity |
|---|---|
| a simple successful call of the endpoint | `functional/positive` |
| expected 4xx, 401 and 404 as endpoint behavior | `functional/negative` |
| response schema, types, required fields, documented status and content type | `contract/positive` |
| violated request schema constraints: required, type, min/max, length, enum, pattern, … | `contract/negative` |
| CRUD/lifecycle and multi-request flows | `scenario/positive` |
| business rejections, invalid state transitions, negative multi-request flows | `scenario/negative` |

An HTTP status may be checked in both `functional` and `contract`, with different meanings:

- `functional`: the endpoint returned the specific expected result;
- `contract`: the status actually returned is allowed by OpenAPI.

This is not duplication as long as the case purpose and the case ID differ.

A file is created only when it contains at least one justified case. No empty files are generated. For a suite type without cases, `plan` output records `no-change` or `BLOCKED` with the reason.

A multi-operation scenario lives in the `scenarios.spec.ts` of its **primary operation**, recorded explicitly as `primaryOperationUid` in the [scenario registry](#scenarios). It is never derived from role order. For `create order → PATCH order → verify order → cleanup`, the file is `orders/patch-by-id/scenarios.spec.ts`, not under the create endpoint.

### Impact by suite type

| Change | Affected file |
|---|---|
| ordinary endpoint behavior, documented 401/404, a functional expectation | `functional.spec.ts` |
| request/response schema, status set, content type, a schema constraint | `contract.spec.ts` |
| dependency graph, `idFrom`, a lifecycle edge, a precondition or cleanup | `scenarios.spec.ts` |
| an endpoint added or removed | all three suite types are analyzed |

## Stable IDs

- Every operation gets a persistent **`operationUid`** that does not depend on `operationId` or on the generated method name; those are mutable attributes of the operation.
- `operationUid` is deterministic, not a random UUID:
  `operationUid = "op_" + base32(sha256(UPPERCASE_METHOD + " " + normalizedPath))[0:12]`
  (RFC 4648 base32, uppercase, no padding).
- Resolution priority for an operation in the spec:
  1. its explicit [`x-api-test-agent-id`](#x-api-test-agent-id) matches the `externalId` of an entry in the [case registry](#case-registry-and-generation-manifest) (`_support/cases.json`): that entry's `operationUid`;
  2. its method + `normalizedPath` matches an active registry entry: that entry's `operationUid`;
  3. otherwise, a new `operationUid` from the deterministic hash. Its `x-api-test-agent-id`, if any, is recorded as the entry's `externalId`.

  The `x-api-test-agent-id` value is an external stable ID, never the `operationUid` itself. `operationId` is not part of the hash. Once assigned, the ID is persisted in `cases.json` and **never recomputed**. When rename detection links a move, the new endpoint inherits the old `operationUid`.
- Truncated-hash collisions are checked. On a collision the hash is lengthened or the run fails; an order-dependent suffix is never appended.
- Case IDs follow the [case ID format](#case-id-format). The concrete constraint value (`50`, `100`) is **not** part of the ID, so a changed limit keeps the case and marks it for review.
- Each test carries its case ID:
  - Playwright: an annotation `{ type: 'caseId', description: '<id>' }`;
  - pytest: `@pytest.mark.api_case_id("<id>")`, registered by the generated `conftest.py` in `pytest_configure` (no `PytestUnknownMarkWarning`).

  The case ID also appears in the generated report.
- Renaming an `operationId` never changes an ID.
- Moving an operation to another path keeps its `operationUid` only with a matching `x-api-test-agent-id` or a move linked by [rename detection](#rename-detection) (automatically only under its thresholds, otherwise after review). An ambiguous move becomes `review` / `BLOCKED`, never a silent re-link.

### Case ID format

```text
ata:<subjectUid>:<suiteType>:<polarity>:<location>:<rule>
```

- `subjectUid`: an `operationUid`, or a `scenarioUid` for multi-operation scenarios in `scenarios.spec.ts`. A single-operation scenario may use an `operationUid` when there is no dependency chain.
- `suiteType`: `functional | contract | scenario` (see [Test suite layout](#test-suite-layout)).
- `polarity`: `positive | negative`.
- `location`: the canonical place being checked.
- `rule`: a stable name of the checked behavior, **without** the constraint value: `maxLength`, not `maxLength-50`. The previous and new values (`before: 50`, `after: 100`) live in the case metadata.

Examples:

```text
ata:op_ABC123:functional:positive:operation:documented-success
ata:op_ABC123:functional:negative:request.path#/brandId:not-found
ata:op_ABC123:functional:negative:request.security:unauthorized
ata:op_ABC123:contract:positive:response.status#/200:documented
ata:op_ABC123:contract:positive:response.content-type#/application~1json:documented
ata:op_ABC123:contract:positive:response.body#:schema
ata:op_ABC123:contract:positive:response.body#/data/id:schema
ata:op_ABC123:contract:negative:request.body#/name:maxLength
ata:op_ABC123:contract:negative:request.query#/limit:maximum
ata:op_ABC123:contract:negative:request.header#/x-api-key:required
ata:scn_XYZ789:scenario:positive:lifecycle:crud
ata:scn_XYZ789:scenario:negative:lifecycle:business-rule
ata:scn_CHECKOUT:scenario:positive:lifecycle:business-rule
ata:scn_CANCEL:scenario:negative:lifecycle:business-rule
```

`location` rules:

| Target | Location |
|---|---|
| query parameter | `request.query#/<name>` |
| path parameter | `request.path#/<name>` |
| header | `request.header#/<lowercase-name>` |
| cookie | `request.cookie#/<name>` |
| request body field | `request.body#<JSON Pointer>` |
| response body field | `response.body#<JSON Pointer>` |
| status | `response.status#/<status>` |
| response content type | `response.content-type#/<RFC 6901-escaped media type>` |
| request content type | `request.content-type` |
| security | `request.security` |
| whole operation | `operation` |
| whole lifecycle scenario | `lifecycle` |

- Nested body fields use a JSON Pointer after `#`: `request.body#/address/city`, `request.body#/items/*/sku`, `response.body#/data/id`.
- RFC 6901 escaping applies: `~` → `~0`, `/` → `~1`. Array elements are written as `*` (an extension of RFC 6901, which only has numeric indexes).
- Header names are lowercased, because HTTP headers are case-insensitive. Query, path and cookie names are kept exactly as in the spec.

#### Encoding and the body root

The colon stays the structural separator of the five parts. In dynamic names:

- `:` is encoded as `%3A`;
- `%` itself is encoded as `%25`;
- a literal `*` is encoded as `%2A` (see [below](#array-wildcard-vs-a-field-named-));
- control, non-ASCII and other disallowed characters use uppercase UTF-8 percent-encoding.

Body grammar: `request.body#<json-pointer>` / `response.body#<json-pointer>`. The JSON Pointer:

- may be empty, which means the body root: `response.body#`, not `response.body#/`;
- starts with `/` when non-empty;
- uses RFC 6901 escaping (`~` → `~0`, `/` → `~1`);
- gets the percent-encoding above applied to dynamic segments **after** the JSON Pointer escaping.

```text
request.body#/address/city
request.body#/items/*/sku
request.body#/meta%3Atag
request.query#/filter%3Atype
response.body#              (body root; e.g. ata:op_ABC123:contract:positive:response.body#:schema)
```

HTTP header field names cannot contain a colon, but the same encoding function applies to every dynamic name.

Parsing:

1. The parser splits the ID into six structural parts (`ata`, subject, suite type, polarity, location, rule) on its five unescaped `:`.
2. It then percent-decodes the dynamic segments. The percent-encoding rules above are unchanged.

Each of these is `INVALID_CASE_ID_ENCODING` (detected without a spec):

- non-canonical escaping (lowercase `%3a` instead of `%3A`);
- an unencoded `%`;
- an unencoded `:` inside `location` (the ID then has more than six parts).

`rule` is always a static value from the [versioned vocabulary](#rule-vocabulary) and never contains `:`.

#### Array wildcard vs. a field named `*`

A bare `*` segment is reserved for the array element wildcard (`request.body#/items/*/sku`). A property literally named `*` is encoded as `%2A` (`request.body#/properties/%2A`). The canonical encoder always encodes a literal `*`, even though standard URI encoders usually leave it unencoded.

Encoding a dynamic JSON Pointer segment:

1. RFC 6901 escaping: `~` → `~0`, `/` → `~1`.
2. Canonical percent-encoding:
   - `%` → `%25`;
   - `:` → `%3A`;
   - a literal `*` → `%2A`;
   - control, non-ASCII and other disallowed characters → uppercase UTF-8 percent-encoding.
3. Segments are joined with `/`.
4. The generator inserts the array wildcard as a separate bare `*` segment **after** user names were encoded.

| Field | Segment |
|---|---|
| `name` | `/name` |
| `meta:tag` | `/meta%3Atag` |
| `a/b` | `/a~1b` |
| `a~b` | `/a~0b` |
| `%value` | `/%25value` |
| `*` | `/%2A` |
| array element | `/*` |

Parsing runs in reverse:

1. Split the pointer into raw segments.
2. A raw segment exactly equal to `*` is the array wildcard.
3. Every other segment is percent-decoded (canonical form).
4. Then RFC 6901 unescaping is applied.

So `%2A` decodes to a field literally named `*` and never becomes a wildcard.

Forbidden:

| Case | Error | Detected |
|---|---|---|
| lowercase `%2a` | `INVALID_CASE_ID_ENCODING` | without a spec |
| a bare `*` where the resolved schema is not an array, including a property named `*` written without `%2A` | `INVALID_ARRAY_WILDCARD` | with a spec |
| double encoding `%252A` (decodes to a property literally named `%2A`, which does not exist) | `INVALID_CASE_LOCATION` | with a spec |

#### One primary case ID per test

The base functional case ID is `ata:<operationUid>:functional:positive:operation:documented-success`. One physical test has **one** primary case ID. Contract checks that run as their own tests in `contract.spec.ts` get their own `contract/*` IDs. If a functional test additionally validates the response contract, for example by calling `expectContract`, that is recorded in its metadata rather than as extra IDs:

```json
{
  "covers": [
    "contract:positive:response.status#/200:documented",
    "contract:positive:response.content-type#/application~1json:documented",
    "contract:positive:response.body#:schema"
  ]
}
```

One physical test does not get several equal case IDs without need.

#### Rule vocabulary

`rule` comes from a **versioned vocabulary**. `cases.json` records `"caseRuleVocabularyVersion": 1`. The version covers the whole case ID vocabulary: there are no separate versions per suite type or polarity.

Built-in vocabulary v1, grouped by `suiteType/polarity`:

```text
functional/positive:  documented-success
functional/negative:  not-found  unauthorized  forbidden
contract/positive:    documented  schema
contract/negative:    required  nullable  type  format  pattern
                      minimum  maximum  exclusiveMinimum  exclusiveMaximum  multipleOf
                      minLength  maxLength  enum  const
                      minItems  maxItems  uniqueItems  minProperties  maxProperties  additionalProperties
                      content-type
scenario/positive:    crud  business-rule
scenario/negative:    business-rule
```

Later versions only add rules (a registry of an older version stays valid):

```text
v2  functional/positive:  accepted-value                 request.<in>#/<name>/<documented value>
    functional/negative:  invalid-credentials            request.security
                          method-not-allowed             operation
                          precondition-failed            request.header#/<name>
v3  functional/positive:  collection-contains, fixture   operation
                          filter, pagination             request.query#/<parameter>
                          sort                           request.query#/<parameter>/<documented value>
                          unique                         response.body#<items pointer>/*<field>
v4  functional/positive:  optional-omitted               request.body#
                          variant                        request.body#<pointer>/@<branch>
    functional/negative:  expired-credentials            request.security
```

This is the architecture's vocabulary. The generator may support only a subset, but it never creates unknown rules. `crud` is only for a general resource lifecycle; `business-rule` covers positive and negative business scenarios, including state transitions. A separate `state-transition` rule may come in a later vocabulary version if `business-rule` proves too broad.

`registry validate` checks the allowed **combination** of `suiteType`, `polarity`, `location` and `rule`, not just that the rule exists. Allowed in v1:

| suiteType | polarity | location | rule | extra condition |
|---|---|---|---|---|
| functional | positive | `operation` | `documented-success` | |
| functional | negative | `request.path#/<name>` | `not-found` | |
| functional | negative | `request.security` | `unauthorized`, `forbidden` | |
| contract | positive | `response.status#/<status>` | `documented` | |
| contract | positive | `response.content-type#/<RFC 6901-escaped media type>` | `documented` | |
| contract | positive | `response.body#<json-pointer>` | `schema` | |
| contract | negative | `request.{body,query,path,header,cookie}#…` | a schema-constraint rule | the rule must describe that target |
| contract | negative | `request.content-type` | `content-type` | |
| scenario | positive | `lifecycle` | `crud` (general resource lifecycle only) | `subjectUid` starts with `scn_`; its definition has `scenarioType: "crud"` |
| scenario | positive | `lifecycle` | `business-rule` (successful business flows, state transitions) | `subjectUid` starts with `scn_` |
| scenario | negative | `lifecycle` | `business-rule` | `subjectUid` starts with `scn_` |
| scenario | negative | `operation` | `business-rule` | single-operation scenario without a dependency chain: `subjectUid` starts with `op_` |

Error examples:

| Case ID fragment | Error |
|---|---|
| `functional:positive:operation:schema` | `INVALID_CASE_RULE_FOR_SUITE` |
| `contract:positive:request.body#/name:documented` | `INVALID_CASE_LOCATION` |
| `contract:negative:operation:documented-success` | `INVALID_CASE_RULE_FOR_SUITE` |
| `op_…:scenario:positive:lifecycle:crud` | `INVALID_CASE_SUBJECT` (lifecycle needs a `scenarioUid`) |

Validation:

- a known built-in rule in an allowed combination for a supported version is valid;
- an unknown rule without a namespace is `INVALID_CASE_RULE`;
- custom rules are allowed only as `x-<namespace>-<rule>`, for any suite type and polarity. They are kept, but automatic impact mapping returns `review` for them unless a plugin/config knows their allowed locations and meaning;
- a registry with a vocabulary version above the supported one is `BLOCKED: UNSUPPORTED_CASE_RULE_VOCABULARY`;
- a legacy registry without a version is treated by migration code as vocabulary `0`, never silently as the current version.

Adding a built-in rule or a new allowed `suiteType/polarity/location/rule` combination requires a new vocabulary version (or an explicitly backward-compatible update of the validator contract) and a migration/compatibility test. For the first implementation, **any** extension of the built-in vocabulary is a version bump. Existing rules are never renamed without an alias/migration.

`nullable` is a logical rule independent of representation: 3.0 `nullable: false` and 3.1 `type: ["string"]` give the same rule after normalization.

#### Scenarios

- A test of one operation stays a `functional` or `contract` case and gets the `operationUid` of the action under test. Calls used as precondition or cleanup go to `relatedOperationUids` and do not change the primary case ID:

  ```json
  {
    "caseId": "ata:op_READ:functional:positive:operation:documented-success",
    "subjectUid": "op_READ",
    "relatedOperationUids": ["op_CREATE", "op_DELETE"]
  }
  ```

- A test in `scenarios.spec.ts` that checks a chain of at least two operations gets a `scenarioUid`. A single operation uses its `operationUid`.

**Scenario definition.** Every `scenarioUid` has a definition with a required, ordered list of `steps`:

```ts
type ScenarioStep = {
  operationUid: string;
  phase: 'setup' | 'action' | 'assertion' | 'cleanup';
};

type ScenarioDefinition = {
  scenarioType: 'crud' | 'business';
  primaryOperationUid: string;
  steps: ScenarioStep[];
  externalId?: string;           // explicit stable scenario ID, see below
  roles?: {                      // crud only: optional metadata for the dependency graph
    create: string | null;
    read: string | null;
    update: string | null;
    delete: string | null;
  };
};
```

CRUD scenario:

```json
{
  "primaryOperationUid": "op_UPDATE",
  "roles": {
    "create": "op_CREATE",
    "read": "op_READ",
    "update": "op_UPDATE",
    "delete": "op_DELETE"
  },
  "scenarioType": "crud",
  "steps": [
    { "operationUid": "op_CREATE", "phase": "setup" },
    { "operationUid": "op_UPDATE", "phase": "action" },
    { "operationUid": "op_READ", "phase": "assertion" },
    { "operationUid": "op_DELETE", "phase": "cleanup" }
  ]
}
```

CRUD scenario with missing roles (create → delete, where delete is the action under test, followed by a read that must fail):

```json
{
  "primaryOperationUid": "op_DELETE",
  "roles": { "create": "op_CREATE", "read": "op_READ", "update": null, "delete": "op_DELETE" },
  "scenarioType": "crud",
  "steps": [
    { "operationUid": "op_CREATE", "phase": "setup" },
    { "operationUid": "op_DELETE", "phase": "action" },
    { "operationUid": "op_READ", "phase": "assertion" }
  ]
}
```

Business scenario (checkout):

```json
{
  "primaryOperationUid": "op_PAY",
  "scenarioType": "business",
  "steps": [
    { "operationUid": "op_CREATE_CART", "phase": "setup" },
    { "operationUid": "op_ADD_ITEM", "phase": "setup" },
    { "operationUid": "op_PAY", "phase": "action" },
    { "operationUid": "op_GET_INVOICE", "phase": "assertion" },
    { "operationUid": "op_DELETE_CART", "phase": "cleanup" }
  ]
}
```

Rules:

- `steps` is required for every `scenarioUid`, with at least two steps. Step order is meaningful, and one operation may appear several times.
- `primaryOperationUid` must appear in at least one step. In an ordinary business scenario the primary usually has phase `action`.
- `relatedOperationUids` are derived from `steps`: every step's operation except the primary, deduplicated, in order of first appearance. For the checkout example: `["op_CREATE_CART", "op_ADD_ITEM", "op_GET_INVOICE", "op_DELETE_CART"]`.
- `roles` is allowed only for `scenarioType: "crud"`. It is optional CRUD metadata for the [dependency graph](#dependency-graph-impact), never the basis of identity. Every non-null UID in `roles` must appear in `steps`. Business scenarios have no `roles`.
- Cleanup is defined by `phase: "cleanup"`, so it also works without a CRUD `delete` role.

**Primary operation.** `primaryOperationUid` determines:

- which endpoint folder holds the `scenarios.spec.ts`;
- the `operationUid` of the corresponding `SuiteImpact`;
- the main endpoint shown in reports.

Choosing it:

- when the scenario checks a specific action operation, that operation is primary;
- setup and cleanup operations never become primary just because of their phase or role;
- for a full lifecycle scenario without an obvious main operation, the primary is set in reviewed deps or the registry;
- an ambiguous primary is `review` / `BLOCKED`, never the first step;
- on a rename/move, the primary operation keeps its UID under the general registry rules.

**`scenarioUid` formula.** Two mutually exclusive formulas (RFC 4648 base32, uppercase, no padding):

1. With an `externalId`, which is the preferred stable source of identity:

   ```text
   scenarioUid = "scn_" + base32(sha256("id=<canonicalExternalId>"))[0:12]
   ```

   `<canonicalExternalId>` is the `externalId` resolved through `externalScenarioIdAliases` to its canonical value, used byte for byte.

2. Without an `externalId`:

   ```text
   scenarioUid = "scn_" + base32(sha256("type=<scenarioType>;steps=<phase>:<operationUid>><phase>:<operationUid>>…"))[0:12]
   ```

   Example input:

   ```text
   type=business;steps=setup:op_CREATE_CART>setup:op_ADD_ITEM>action:op_PAY>assertion:op_GET_INVOICE>cleanup:op_DELETE_CART
   ```

`externalId` and `steps` never go into the same hash. A stable external ID therefore gives the same UID even if the registry is lost and the steps have changed meanwhile.

- `primaryOperationUid`, `roles` and test names are **not** part of either hash.
- Once written to `cases.json` (`scenarios`), a `scenarioUid` is never recomputed. These changes update the definition and keep the UID:
  - adding or removing a step;
  - changing a phase;
  - changing the primary;
  - a confirmed rename/move of an operation.
- At bootstrap without a registry, the UID is computed from the `externalId` when there is one, otherwise from the current steps.
- Collisions are checked the same way as for `operationUid`.
- Several case IDs may share one `scenarioUid`. A successful checkout and a rejected payment can use the same operation sequence but differ in polarity, rule, test data and assertions:

  ```text
  ata:scn_CHECKOUT:scenario:positive:lifecycle:business-rule
  ata:scn_CHECKOUT:scenario:negative:lifecycle:business-rule
  ```

- Two chains that need independent tracking despite identical steps get explicit, stable `externalId`s, so their UIDs come from formula 1 and differ. A mutable test name never goes into the hash.

**External scenario IDs** follow the same rules as operation external IDs ([`x-api-test-agent-id`](#x-api-test-agent-id)):

- Two active scenarios never share an `externalId`: both get `BLOCKED: DUPLICATE_EXTERNAL_SCENARIO_ID`, with both JSON Pointers in the report.
- Changing the steps never changes the UID of a scenario with an `externalId`.
- Changing the `externalId` of a known scenario is `BLOCKED: STABLE_SCENARIO_ID_CHANGED` until a reviewed alias/migration exists in `externalScenarioIdAliases`:

  ```json
  { "externalScenarioIdAliases": { "checkout.old": "checkout" } }
  ```

- Scenario aliases are stored separately from operation aliases (`externalIdAliases`) and are never mixed. They resolve transitively, and a cycle is `BLOCKED`.

### `normalizedPath`

Used for operation identity and the initial hash:

```text
/brands/{id}      → /brands/{}
/brands/{brandId} → /brands/{}
```

- The HTTP method is uppercased.
- Path parameter names are not part of identity: each `{name}` becomes `{}`.
- Segment order and count are kept.
- A trailing slash is significant and kept.
- Static segments keep their case.
- Repeated slashes are not collapsed.
- Percent-encoded characters are not decoded.
- A query string in an OpenAPI path is not allowed and is never part of identity.

So `{id} → {brandId}` gives the same initial UID at bootstrap. A separate `parameter-renamed` change is still emitted, because the argument name of the generated API method may change.

### `x-api-test-agent-id`

- It must be non-empty and unique across the whole spec.
- If two operations share one value:
  - both get `BLOCKED: DUPLICATE_API_TEST_AGENT_ID`;
  - the report shows both JSON Pointers;
  - no automatic IDs are assigned to them;
  - the fix belongs in the spec.
- If the value changes on an already known endpoint:
  - the existing `operationUid` is not replaced automatically;
  - a `stable-id-changed` change with action `review` is emitted;
  - the result is `BLOCKED` by default, since the change could break the link to historical case IDs.

  The change is accepted only through an explicit migration mapping, `externalIdAliases` (old external ID → new external ID). The mapping is about `x-api-test-agent-id`, not the OpenAPI `operationId`, hence the name:

  ```json
  { "externalIdAliases": { "brands.get-one.old": "brands.get-one" } }
  ```

  After a confirmed migration the internal `operationUid` is kept, and the new value becomes the current external stable ID.

#### Where aliases live

- The authoritative store is `_support/cases.json` (`externalIdAliases` for operations, `externalScenarioIdAliases` for [scenarios](#scenarios), kept separate), because aliases are part of the identity history.
- A one-off input file may be passed with `--id-aliases api-test-agent.id-aliases.json`. It is migration input only. The command:
  1. checks the aliases for cycles, duplicates and conflicts;
  2. shows a proposal;
  3. writes them to `cases.json` only with an explicit `--apply-registry`.

  After that, `cases.json` remains the source of truth. The CLI flag never creates a second persistent store.
- Aliases resolve transitively; cycles are forbidden:

  ```text
  a → b → c   allowed, canonical value c
  a → b → a   BLOCKED
  ```

### Bootstrap for existing suites

Suites generated before stable IDs have no `cases.json` and use the old `positive.spec.ts` / `negative.spec.ts` layout. A migration step:

1. reads the operation key (`METHOD /path`) from the header comment of each generated test file (the generator already writes `// <METHOD /path> · positive|negative cases. Generated by api-test-agent <version>.`);
2. matches it against the current spec;
3. creates `_support/cases.json`, assigns deterministic IDs and maps each existing case to a suite type and polarity:

   | Existing case | New suite type / polarity |
   |---|---|
   | a simple positive test (documented success) | `functional/positive` |
   | a schema-derived negative case (required, type, min/max, length, enum, …) | `contract/negative` |
   | a 401 / 404 case | `functional/negative` |
   | a lifecycle (CRUD chain) test | `scenario/positive` or `scenario/negative`; a `crud` scenario definition whose `steps` come from the test's calls in order. `primaryOperationUid` and phases come from reviewed deps, otherwise `review` |
   | an ambiguous hand-written test | `review`, no ID assigned automatically |

   Moving cases from the old files into `functional.spec.ts` / `contract.spec.ts` / `scenarios.spec.ts` follows the [generated vs. hand-written rules](#generated-vs-hand-written-files): generated files are replaced only via `--apply-generated`, everything else gets a proposed patch;
4. creates the manifest **without** trusting the working tree. For each file, the fresh generator output for the same spec and the existing file are both hashed with the [canonical file hash](#case-registry-and-generation-manifest) (UTF-8, line endings normalized to LF, then SHA-256):
   - equal hashes: `ownership: generated`;
   - different hashes: `ownership: unknown` (see [Generation manifest after a merge](#generation-manifest-after-a-merge)).

   A raw difference only in CRLF vs. LF is not a manual change. A BOM, changed content or a different encoding is handled by the same canonical hashing function used for the manifest, never by a separate bootstrap rule;
5. marks ambiguous matches and hand-written tests as `review` and changes none of them automatically.

## Baseline

Source priority for the "before" spec:

1. `--base <file-or-url>` passed explicitly;
2. the spec at the Git **merge base** of the PR (not the previous build);
3. a stored CI artifact from the last successful run on the base branch (a download needs [`--allow-network`](#network-access));
4. the snapshot the generator already writes into the suite: `<tests-dir>/_support/openapi.snapshot.ts` (TypeScript) or `<tests-dir>/_support/openapi_snapshot.json` (Python).

Snapshots are usable only with metadata: `generatorVersion`, `specHash`, `source`, `capturedRevision`. Today the TypeScript snapshot carries only the source and hash in its header comment, and the Python snapshot is the bare spec with no metadata. The metadata must be added (for example a sibling `_support/openapi.snapshot.meta.json`, step 3 of the [implementation order](#implementation-order)); until then a snapshot baseline is `BLOCKED: BASE_SPEC_MISSING`.

A missing or incompatible baseline is `BLOCKED: BASE_SPEC_MISSING`, an analysis result, not a runtime error (see [Exit codes](#exit-codes-and-empty-results)). The tool never compares a live spec URL with itself and reports "no changes".

## Network access

Any HTTP(S) access requires an explicit **`--allow-network`**. This includes:

- `--base <url>` and `--head <url>`;
- remote `$ref`s;
- redirects;
- downloading external baseline artifacts.

```text
api-test-agent diff --base snapshot.json --head https://example/openapi.json --allow-network
```

A URL argument alone is not permission. The separate flag makes behavior obvious in CI and prevents unexpected loading of remote `$ref`s.

Without `--allow-network`, a URL is a **configuration error** (exit code 2), not `BLOCKED`. `BLOCKED` means the input was allowed but a correct comparison is impossible.

Additional guards:

- `--allow-host <hostname>` (repeatable);
- `localhost`, private IP ranges and cloud metadata endpoints denied by default;
- limits on redirects, response size and timeout;
- credentials only from environment variables, always redacted.

Preferred CI path: download the spec in a separate, controlled step, then pass local files to `diff`.

## Change kinds

```ts
type ChangeKind =
  | 'operation-added' | 'operation-removed'
  | 'operation-moved'            // path changed (candidate unless confirmed)
  | 'operationId-renamed'        // same method + normalized path, new operationId
  | 'stable-id-changed'          // x-api-test-agent-id changed on a known endpoint (needs the registry)
  | 'parameter-changed' | 'parameter-renamed'   // {id} → {brandId}: zero contract change, matters for codegen
  | 'request-changed' | 'response-changed'
  | 'schema-constraint-changed'  // see below
  | 'example-changed'            // example / default changed: non-breaking, test-relevant when used for payloads
  | 'servers-changed'            // reported, never regenerates cases
  | 'retired-operation-reappeared'; // a retired endpoint is back: review, no automatic reactivation (needs the registry)

// Schema facets: the negative rules of the vocabulary that describe a schema keyword.
type Facet =
  | 'required' | 'nullable' | 'type' | 'format' | 'pattern'
  | 'minimum' | 'maximum' | 'exclusiveMinimum' | 'exclusiveMaximum' | 'multipleOf'
  | 'minLength' | 'maxLength' | 'enum' | 'const'
  | 'minItems' | 'maxItems' | 'uniqueItems' | 'minProperties' | 'maxProperties' | 'additionalProperties';

type OpenApiChange = {
  kind: ChangeKind;
  operationUid: string;
  operationKey: string;          // METHOD + path, for humans
  pointer?: string;              // JSON Pointer to the changed component
  scope?: 'request' | 'response';
  facet?: Facet;                 // schema-constraint-changed only
  before?: unknown;
  after?: unknown;
  breaking: 'yes' | 'no' | 'unknown';   // compatibility verdict (from oasdiff)
  testRelevant: boolean;                  // whether existing or generated tests are affected
  confidence?: number;                    // rename / move detection only
};

type BlockedResult = {
  code: string;                  // e.g. BASE_SPEC_MISSING, OASDIFF_UNSUPPORTED_CONSTRUCT, DUPLICATE_API_TEST_AGENT_ID
  pointers?: string[];           // JSON Pointers involved
  reason: string;
};

// changes.json
type OpenApiChangeSet = {
  baseRevision: string;
  headRevision: string;
  baseSource: 'flag' | 'merge-base' | 'ci-artifact' | 'snapshot';
  engine: { name: 'oasdiff'; version: string; versionMismatch: boolean };
  changes: OpenApiChange[];
  blocked: BlockedResult[];
};

type SuiteType = 'functional' | 'contract' | 'scenario';
type Polarity = 'positive' | 'negative';

type TestImpact = {
  caseId: string;
  subjectUid: string;            // operationUid, or scenarioUid for multi-operation scenarios
  suiteType: SuiteType;
  polarity: Polarity;
  file: string;                  // e.g. brands/get-by-id/functional.spec.ts
  relatedOperationUids?: string[];
  action: 'add' | 'review' | 'regenerate-proposed' | 'no-change' | 'blocked';
  reason: string;
  affectedScenarios: string[];
};

// One entry per operation and suite type, also when the suite has no cases (no empty file is created).
type SuiteImpact = {
  operationUid: string;          // for the scenario suite: the scenario's primaryOperationUid
  suiteType: SuiteType;
  scenarioUids?: string[];       // scenario suite only: scenarios whose primary is this operation
  relatedOperationUids?: string[];
  file: string | null;           // null when no file exists or is proposed
  action: 'add' | 'review' | 'no-change' | 'blocked';
  reason: string;
};

// test-impact.json (produced by `plan`)
type ScenarioStepRef = {
  index: number;                 // zero-based index in the corresponding (base or head) scenario definition
  operationUid: string;
  phase: 'setup' | 'action' | 'assertion' | 'cleanup';
};

type AffectedScenarioStep = {
  change: 'added' | 'removed' | 'moved' | 'modified' | 'operation-removed';
  base?: ScenarioStepRef;        // the step in the base scenario definition
  head?: ScenarioStepRef;        // the step in the head scenario definition
  reason: string;
};

// One entry per scenario affected by a change.
type ScenarioImpact = {
  scenarioUid: string;
  scenarioType: 'crud' | 'business';
  primaryOperationUid: string;
  affectedSteps: AffectedScenarioStep[];
  action: 'add' | 'review' | 'regenerate-proposed' | 'no-change' | 'blocked';   // same as TestImpact
  reason: string;
};

type TestImpactReport = {
  impacts: TestImpact[];
  suites: SuiteImpact[];
  scenarios: ScenarioImpact[];
  untrackedTests: UntrackedTest[];
  blocked: BlockedResult[];
};

type UntrackedTest = {
  caseId: null;
  testRef: { file: string; title: string; line: number };
  matchedOperationUid?: string;
  tracking: 'untracked';
  action: 'review';
  reason: string;
};
```

`ScenarioImpact` is self-contained: every affected step carries references into **both** scenario definitions, so a reader needs no other registry version.

| Change | `change` | Sides present |
|---|---|---|
| a step was added to the scenario definition | `added` | `head` only |
| a step was removed from the scenario definition | `removed` | `base` only |
| pure reorder, step content unchanged | `moved` | `base` and `head`, different `index` |
| `phase` or `operationUid` changed (with or without a new position) | `modified` | `base` and `head` |
| the operation was removed from OpenAPI, the step is still in the head definition | `operation-removed` | `base` and `head`, even if identical; `operationUid` is the operation's base UID |

- When both the index and the phase changed, the step gets one `modified` entry with both sides, and `reason` lists both changes. `moved` is only for a pure reorder.
- A change that affects the whole scenario lists all its steps.
- A problem with the scenario registry entry as a whole, not tied to one step, gives `affectedSteps: []` and the cause in `reason`.
- `relatedOperationUids` are derived from the head `steps`.
- **Primary operation removed.** When the `primaryOperationUid` was removed from OpenAPI, the impact keeps that UID, `action` is `blocked` and `reason` is `PRIMARY_OPERATION_REMOVED`; the same code goes to `blocked[]`. A new primary is never chosen automatically.
- Markdown report:
  - base/head indexes are shown as `index + 1`;
  - a missing side is shown as `—`;
  - an operation removed from OpenAPI is marked `removed from specification`.

A step removed from the scenario definition:

```json
{
  "change": "removed",
  "base": { "index": 3, "operationUid": "op_GET_INVOICE", "phase": "assertion" },
  "reason": "Step removed from the scenario definition"
}
```

A step whose operation was removed from OpenAPI:

```json
{
  "change": "operation-removed",
  "base": { "index": 1, "operationUid": "op_ADD_ITEM", "phase": "setup" },
  "head": { "index": 1, "operationUid": "op_ADD_ITEM", "phase": "setup" },
  "reason": "POST /carts/{cartId}/items removed from specification; the step is still in the head scenario definition"
}
```

**Breaking and "the test needs an update" are separate flags.** Example: `maxLength 50 → 100` on a request field is not breaking (`breaking: 'no'`), but the existing `contract/negative` case "51 chars → 4xx" is now wrong (`testRelevant: true`, impact `review` / `regenerate-proposed`). The same applies separately to enum values added/removed, required ↔ optional, and type changes.

Statuses and actions are distinct:

- `BLOCKED: <CODE>` is an analysis result: a correct answer is impossible with the given input. It goes to `blocked[]` and is subject to `--fail-on blocked`.
- `review`, `regenerate-proposed`, `add`, `no-change` and `blocked` are `TestImpact` / `UntrackedTest` **actions**: what a human or a later step should do with a case. Action `blocked` means the case cannot be updated until a `BLOCKED` result above is resolved.
- Configuration and runtime errors are neither: the command stops with exit code 2 (see [Exit codes](#exit-codes-and-empty-results)).

Use the same normalized API model as the `plan` output and the dependency graph. This design does **not** require AI.

## Compatibility engine

- The full compatibility table (what is breaking) is **not** reimplemented. [`oasdiff`](https://github.com/oasdiff/oasdiff) is used as an external engine.
- The agent's own layer covers case IDs, test impact, example changes and the dependency graph.
- The Go binary is **not** bundled into the npm package. It is found through `OASDIFF_BIN` or `PATH`; CI installs the pinned version.
- A missing `oasdiff` executable is a configuration/runtime error (exit code 2), not `BLOCKED`: the analysis did not run at all. The message includes install instructions.

### Version pinning

- The supported version is a constant in the package code, covered by a test:
  `export const SUPPORTED_OASDIFF_VERSION = '...';`
  It may be duplicated in `package.json` as metadata, but the constant is the source of truth. CI examples install exactly this version.
- Before diffing, the tool runs `oasdiff --version` (oasdiff 1.34.1 has no `version` subcommand):
  - exact match: continue;
  - a different version: configuration error, exit code 2, with the actual and expected versions in the message;
  - unrecognized version output: exit code 2.
- `--allow-engine-version-mismatch` continues with a warning, for deliberately testing another version. The actual version is always recorded in `changes.json`. CI does not use this flag by default.
- A version mismatch is never `BLOCKED`: it describes the local tool, not uncertainty in the OpenAPI contract.

### OpenAPI 3.1

`oasdiff` supports OpenAPI 3.1, including JSON Schema 2020-12, and compares 3.0 with 3.1 through `--auto-upgrade`, so 3.1 specs are **not** blocked as a whole. Known limits:

- `$dynamicRef` / `$dynamicAnchor` are parsed but not fully resolved;
- `components.pathItems` may not reach the diff model.

A preflight scan runs before the engine. If a spec uses these constructs, the result is `BLOCKED: OASDIFF_UNSUPPORTED_CONSTRUCT`.

Before the implementation PR is merged, the pinned `oasdiff` version must be verified against a real integration fixture made from the Toolshop 3.1 spec.

## Normalization

Must produce **zero** changes:

- `$ref` moved or renamed with identical resolved content;
- inline schema ↔ component;
- equivalent `allOf` expansion;
- formatting and key order;
- the equivalent 3.0 `nullable: true` → 3.1 `type: [x, 'null']` migration.

Reported specially:

- Path parameter renamed (`/brands/{id}` → `/brands/{brandId}`): zero contract changes, one `parameter-renamed` (method signatures in API objects change).
- Trailing slash: significant by default (`/brands` and `/brands/` are different operations).
- `servers` changes: shown separately, never regenerate cases.
- `example` / `default` changes: non-breaking but test-relevant, because the generator uses them as payload sources; listed in their own report section.

## Rename detection

The HTTP method must match; a candidate with a different method is discarded. The method is not part of the score.

Exact rules are applied first:

| Signal | Confidence | Result |
|---|---|---|
| Same `x-api-test-agent-id` | 1.00 | same operation |
| Same method + normalized path, only `operationId` changed | 1.00 | `operationId-renamed` |
| Unique same method + `operationId`, path changed | 0.95 | `operation-moved` |
| Unique same method + full contract fingerprint (request, response, parameters, security), even if both path and `operationId` changed | 0.90 | `operation-moved` |

Remaining candidates are scored as a sum of weights:

| Feature | Weight |
|---|---|
| Same `operationId` | 0.30 |
| Same request schema fingerprint | 0.20 |
| Same response schema fingerprint | 0.20 |
| Same parameter signature | 0.15 |
| Similar resource/path skeleton | 0.10 |
| Same security requirements | 0.05 |

Thresholds:

| Score | Result |
|---|---|
| ≥ 0.90 | linked automatically (old `operationUid` kept) |
| 0.70–0.89 | `review` |
| < 0.70 | `operation-removed` + `operation-added` |

Automatic linking also requires a **unique best candidate leading the runner-up by at least 0.15**. Otherwise the result is `review`, even above 0.90.

So a fully equivalent move with a rename can be linked automatically, a partial structural match lands in `review`, and a weak match stays removed + added.

`summary` and `description` are not part of the score.

## Dependency graph impact

When a create operation's response changes, every dependent scenario is checked. Each `idFrom` in `deps.json` is validated against the head spec:

- the pointer exists;
- its type is compatible with the path parameter it feeds;
- the referenced operations still exist;
- cleanup is still available.

Example: `/id` became `/data/id`. The create operation gets `review`; dependent read/update/delete scenarios get `blocked`. A new pointer may be **proposed**, never written to `deps.json` automatically.

Each `fill` source in `deps.json` (a create body field read from existing data at run time) is validated the same way:

- the source operation still exists and is still a `GET` without unknown required parameters;
- its `pointer` still exists in the source's success response schema, and its type is compatible with the filled field;
- the filled field still exists in the create request body.

A failed check makes the chain `blocked`; the generator already refuses such a chain with the reason, so `plan` reports the same cause before regeneration.

Scenario impact follows the [scenario definitions](#scenarios):

- a change to any operation in a scenario's `steps` affects that scenario, whatever the step's phase;
- "cleanup is still available" means the scenario still has a working `phase: "cleanup"` step, with or without a CRUD `delete` role;
- CRUD `roles`, when present, add dependency-graph edges (create → read/update/delete), but identity and impact are computed from `steps`.

## Generated vs. hand-written files

The layout from PR #1 (API objects, TypeScript only for now) is respected. The rules are language-independent (TypeScript and Python):

- Generated files may be changed automatically **only** with an explicit `--apply-generated`, and only when the file still has the generated header, its hash matches the [generation manifest](#case-registry-and-generation-manifest) and its ownership is `generated` (not `generated-modified` or `unknown`). This covers generated API object bases (`_support/api/generated/*ApiBase.ts`), generated spec/test files (`.ts`, `.py`) and the snapshot.
- `_support/api/<Name>Api.ts`, hand-written tests and generated files edited by a human are never rewritten: the tool proposes a patch.
- After a proposal or apply, the project's own validation runs:
  - TypeScript: `tsc --noEmit`; references to old methods in child classes and hand-written specs are listed via TypeScript diagnostics / AST;
  - Python: at least `pytest --collect-only`, plus mypy/pyright when the project has them configured.

### Case registry and generation manifest

The two files have separate responsibilities:

- **`_support/cases.json`** is the authoritative registry of stable `operationUid`s and case IDs. It keeps identity across generations.
- **`_support/generation-manifest.json`** is the authoritative registry of file ownership and hashes. It decides which files may be overwritten safely.

The manifest only references IDs; it does not duplicate the operation mapping.

`cases.json`:

```json
{
  "caseRuleVocabularyVersion": 1,
  "cases": {
    "ata:op_ABC123:contract:positive:response.body#:schema": {
      "location": "response.body#",
      "polarity": "positive",
      "rule": "schema",
      "subjectUid": "op_ABC123",
      "suiteType": "contract"
    },
    "ata:op_ABC123:functional:negative:request.path#/id:not-found": {
      "location": "request.path#/id",
      "polarity": "negative",
      "rule": "not-found",
      "subjectUid": "op_ABC123",
      "suiteType": "functional"
    },
    "ata:scn_XYZ789:scenario:positive:lifecycle:crud": {
      "location": "lifecycle",
      "polarity": "positive",
      "rule": "crud",
      "subjectUid": "scn_XYZ789",
      "suiteType": "scenario"
    }
  },
  "externalIdAliases": {
    "brands.get-one.old": "brands.get-one"
  },
  "externalScenarioIdAliases": {
    "checkout.old": "checkout"
  },
  "operations": {
    "op_ABC123": {
      "externalId": "brands.get-one",
      "method": "GET",
      "normalizedPath": "/brands/{}",
      "operationId": "getBrand",
      "path": "/brands/{id}"
    },
    "op_OLD999": {
      "lastValidatedGeneratorVersion": "0.2.0",
      "method": "GET",
      "normalizedPath": "/brands/legacy",
      "path": "/brands/legacy",
      "retiredRevision": "abc123",
      "retiredSpecHash": "...",
      "status": "retired"
    }
  },
  "scenarios": {
    "scn_CHECKOUT": {
      "externalId": "checkout",
      "primaryOperationUid": "op_PAY",
      "scenarioType": "business",
      "steps": [
        { "operationUid": "op_CREATE_CART", "phase": "setup" },
        { "operationUid": "op_ADD_ITEM", "phase": "setup" },
        { "operationUid": "op_PAY", "phase": "action" },
        { "operationUid": "op_GET_INVOICE", "phase": "assertion" },
        { "operationUid": "op_DELETE_CART", "phase": "cleanup" }
      ]
    },
    "scn_XYZ789": {
      "primaryOperationUid": "op_UPDATE",
      "roles": {
        "create": "op_CREATE",
        "read": "op_READ",
        "update": "op_UPDATE",
        "delete": "op_DELETE"
      },
      "scenarioType": "crud",
      "steps": [
        { "operationUid": "op_CREATE", "phase": "setup" },
        { "operationUid": "op_UPDATE", "phase": "action" },
        { "operationUid": "op_READ", "phase": "assertion" },
        { "operationUid": "op_DELETE", "phase": "cleanup" }
      ]
    }
  },
  "schemaVersion": 1
}
```

- An entry without `status` is active; `"status": "retired"` marks a [tombstone](#retired-entries-tombstones).
- `externalId` is the operation's current `x-api-test-agent-id`, when it has one.
- A case entry may also carry metadata: `covers`, `relatedOperationUids`, `before` / `after`.
- The operations referenced by the scenarios are omitted from the example for brevity; a real registry must contain them.
- Each entry under `scenarios` is a [scenario definition](#scenarios).

`generation-manifest.json`:

```json
{
  "caseRegistryHash": "...",
  "files": {
    "brands/get-by-id/contract.spec.ts": {
      "caseIds": ["ata:op_ABC123:contract:positive:response.body#:schema"],
      "operationUids": ["op_ABC123"],
      "ownership": "generated",
      "sha256": "...",
      "suiteType": "contract"
    },
    "brands/get-by-id/functional.spec.ts": {
      "caseIds": ["ata:op_ABC123:functional:negative:request.path#/id:not-found"],
      "operationUids": ["op_ABC123"],
      "ownership": "generated",
      "sha256": "...",
      "suiteType": "functional"
    }
  },
  "generatorVersion": "0.2.0",
  "schemaVersion": 1,
  "spec": { "hash": "...", "revision": "...", "source": "openapi.yaml" }
}
```

- `suiteType` says which of the three files a test file is (`functional`, `contract`, `scenario`).
- `ownership` is one of `generated`, `generated-modified`, `unknown`, `hand-written` (see [Generation manifest after a merge](#generation-manifest-after-a-merge)).
- **Canonical file hash:** SHA-256 over UTF-8 content after normalizing line endings to LF. It is one shared function, used by generation, bootstrap, merge and `manifest validate`.
- The manifest does not include its own hash. It is written **last**, only after every file was generated successfully.
- Hand-written files may be listed with `ownership: "hand-written"`, but their hash never grants permission to overwrite.

#### Canonical format

- The registry file (and the manifest) is UTF-8 with LF line endings, 2-space indentation and a trailing newline.
- Keys of every object are sorted lexicographically. The only exception: CRUD `roles` keep the fixed order `create`, `read`, `update`, `delete`.
- Arrays are sorted when their order carries no meaning. Scenario `steps` keep their order: it is meaningful.
- The writer always produces identical output for identical data.

#### Retired entries (tombstones)

Removed operations and cases are never deleted from the registry. They stay as tombstones (see `op_OLD999` above), so an old UID can never be reused by another operation. A tombstone keeps:

- `status: "retired"`;
- `method`, `path`, `normalizedPath`;
- `retiredRevision`, `retiredSpecHash`;
- `lastValidatedGeneratorVersion`.

If a retired endpoint appears again, its old UID is **not** reactivated automatically. `diff` emits `retired-operation-reappeared` with action `review`, and the user chooses explicitly:

- reactivate the old UID, if it really is the same contract;
- create a new UID, if it is a new operation at the same address.

#### Merge conflicts

`cases.json` is a historical registry. It is **never** rebuilt from the current spec after a conflict: that could change IDs and lose the link to removed or moved endpoints.

Conflicts are resolved with a three-way registry merge. The main supported form reads the three Git index stages:

```text
api-test-agent registry merge --git-index tests/api/_support/cases.json
```

Stage 1 is the merge base, stage 2 is ours, stage 3 is theirs. The working file with conflict markers is never parsed as JSON. The command:

1. checks that the path really has three unmerged stages;
2. reads the versions from the Git index;
3. runs the semantic three-way merge;
4. without conflicts, writes the canonical `cases.json`;
5. runs `registry validate` (syntax always; schema-aware with `--spec`);
6. never runs `git add`: the user reviews and stages the file;
7. with semantic conflicts left, does not replace the working file with a partial result, and writes a report with `CASE_REGISTRY_MERGE_CONFLICT` instead.

For CI and unit tests the explicit form stays:

```text
api-test-agent registry merge \
  --base cases.base.json --ours cases.ours.json --theirs cases.theirs.json \
  --out cases.json
```

A custom Git merge driver (`.gitattributes`) is **not** part of the first implementation: it needs local Git setup and can hide semantic conflicts. It may come later as an opt-in wrapper over the same merge function.

Merged automatically:

- changes to different UIDs;
- identical unchanged entries (deduplicated);
- new, different case IDs;
- metadata, only when it does not contradict;
- a tombstone vs. an unchanged entry, in favor of the tombstone only when the corresponding branch confirmed the removal.

Never merged automatically:

- one external ID pointing to different `operationUid`s, or one external scenario ID pointing to different `scenarioUid`s;
- one `operationUid` pointing to different active endpoints;
- one case ID with different `suiteType` / `polarity` / `location` / `rule`;
- an alias cycle;
- competing changes to one scenario: its `steps` (order or content), `scenarioType`, `primaryOperationUid` or `roles`;
- one branch retired an entry while the other changed it without an explicit rename mapping.

These give `BLOCKED: CASE_REGISTRY_MERGE_CONFLICT` with the JSON Pointers of the conflicting entries.

`registry merge` always runs [syntax validation](#registry-validation) on its result. Schema-aware validation runs only with `--spec <head-spec>`:

```text
api-test-agent registry merge --git-index <path>                       # safe structural merge, no spec
api-test-agent registry merge --git-index <path> --spec openapi.yaml   # plus full check of active entries against head
```

After a manual resolution, `registry validate` is required. In CI, always pass the head spec to `merge`, or run right after it:

```text
api-test-agent registry validate <path> --spec <head-spec> --require-spec
```

`cases.json` may not be rebuilt from the spec, because it holds historical identity.

#### Registry validation

Validation has two levels: syntax without a spec, and semantics with a spec.

**Syntax (no spec):** `api-test-agent registry validate _support/cases.json` checks only what needs no OpenAPI:

- the JSON Schema and version of the registry;
- canonical sorting and encoding;
- the format of `operationUid`, `scenarioUid` and case IDs;
- the vocabulary and `suiteType/polarity/location/rule` combinations;
- case → operation/scenario references;
- every scenario definition:
  - at least two `steps`, each with an allowed `phase` (`setup`, `action`, `assertion`, `cleanup`) and an existing operation;
  - `primaryOperationUid` present in `steps`;
  - no `roles` on a `business` scenario;
  - every non-null CRUD role present in `steps`;
- uniqueness of active operation and scenario external IDs;
- both alias maps (`externalIdAliases`, `externalScenarioIdAliases`) and no cycles;
- tombstones and no reuse of retired IDs;
- JSON Pointer syntax, including bare `*` vs. `%2A`.

Without a spec the validator does **not** claim that a `*` really points into an array, that `%2A` is really an object property, that a body field/property/parameter exists, or that a facet applies to the schema it names. The report states:

```json
{ "syntaxValidation": "passed", "schemaValidation": "not-run" }
```

This is a success with exit code 0. With `--require-spec`, a missing spec is a configuration error with exit code 2.

**Semantics (with a spec):** `api-test-agent registry validate _support/cases.json --spec openapi.yaml` runs syntax validation first, then schema-aware validation of **active** entries against the given spec (normally head: the spec the current generated suite must match). It checks:

- the active operation exists;
- the method/path ↔ `operationUid` mapping is consistent;
- query/path/header/cookie parameters exist;
- body pointers resolve after `$ref` resolution and normalization;
- a bare `*` appears only where the path goes through an array's `items`;
- `%2A` is treated as a property literally named `*`;
- the `rule` applies to the schema node found;
- response statuses and media types exist;
- CRUD dependency pointers and types are compatible.

Errors: `ACTIVE_OPERATION_NOT_FOUND`, `INVALID_CASE_LOCATION`, `INVALID_CASE_RULE_FOR_SCHEMA`, `INVALID_ARRAY_WILDCARD`.

A location that cannot be checked (unresolved `$ref`, unsupported schema construct, ambiguous composition) is not declared invalid. The result is `BLOCKED: CASE_LOCATION_UNRESOLVED`.

**Which spec in `diff`:** each side is validated against its own spec:

- the base registry/snapshot against the base spec;
- the head/current registry against the head spec;
- a registry after a merge against the head spec.

Validating both registry versions against head only (or baseline only) would give false errors for removed or renamed operations. `diff` passes the already resolved/normalized specs to the internal validator and never downloads them a second time. A manual `registry validate --spec …` uses exactly the spec the user passed.

**Retired entries** are never checked against the current head spec: their endpoint may legitimately no longer exist. For them only these checks run:

- syntax;
- UID uniqueness;
- tombstone correctness;
- no ID reuse;
- integrity of aliases and historical case/scenario references.

The spec at `retiredRevision` is **not** loaded automatically. That would need permanent access to Git history or an external URL, break the no-network default, and make an ordinary `registry validate` depend on historical artifacts. Historical re-validation may become a separate future command; it is not in the first implementation PR.

#### Generation manifest after a merge

The manifest is **never** rebuilt by hashing the current working tree: that would mark a human-edited generated file as untouched.

After a merge, only these hashes are trusted:

- hashes from the base, ours and theirs manifests;
- the hash of a file actually produced by a successful generator run.

Per file:

| Content | Result |
|---|---|
| matches a hash from one of the branches | `ownership: generated`, with that trusted hash |
| matches the new generator output | `ownership: generated`, with the new hash |
| matches no trusted hash | `ownership: generated-modified` |
| no manifest, provenance unknown | `ownership: unknown` |

`--apply-generated` never overwrites `generated-modified` or `unknown` files; it only proposes a patch, with action `review` and reason `GENERATED_FILE_MODIFIED`.

`registry merge` does not recompute file hashes or change ownership. The manifest can be restored only from branch manifests and real generator outputs. `api-test-agent manifest validate` compares working files with trusted hashes and never accepts a mismatch as a new baseline.

## Untracked tests

Hand-written tests and tests moved in by `adapt` have no case ID. They never get a stable case ID automatically from a file or test name.

- In the impact report they appear in `untrackedTests` (type `UntrackedTest` above), not in `TestImpact`:

  ```json
  {
    "caseId": null,
    "testRef": { "file": "tests/legacy/brands.spec.ts", "title": "rejects long brand name", "line": 42 },
    "matchedOperationUid": "op_ABC123",
    "tracking": "untracked",
    "action": "review",
    "reason": "Test appears to cover the changed operation but has no stable caseId"
  }
  ```

- The analyzer may infer probable coverage from API calls and assertions, but that is not a stable mapping between runs.
- `adapt` offers a separate migration plan. It:
  1. shows the inferred mapping;
  2. proposes a case ID, including its suite type and polarity, and for multi-operation tests a scenario definition (`steps`, phases, primary);
  3. adds the annotation/marker only after confirmation;
  4. writes the confirmed ID to `cases.json`.

## Exit codes and empty results

| Code | Meaning |
|---|---|
| 0 | analysis completed and the selected policy passed |
| 1 | analysis completed and a `--fail-on` policy triggered |
| 2 | the command could not run correctly: configuration or runtime error |

There is no separate code for `BLOCKED`.

- Every `BLOCKED` result is an analysis result, written to the report: `BASE_SPEC_MISSING`, `OASDIFF_UNSUPPORTED_CONSTRUCT`, `DUPLICATE_API_TEST_AGENT_ID`, `DUPLICATE_EXTERNAL_SCENARIO_ID`, `STABLE_SCENARIO_ID_CHANGED`, `PRIMARY_OPERATION_REMOVED`, `CASE_LOCATION_UNRESOLVED`, `CASE_REGISTRY_MERGE_CONFLICT`, `UNSUPPORTED_CASE_RULE_VOCABULARY`, a changed `x-api-test-agent-id` without an alias, an alias cycle. They give exit code 1 under the `blocked` policy, or 0 with `--fail-on never`.
- `registry validate` and `manifest validate` exit with 1 when they find an invalid entry (`INVALID_*`, `ACTIVE_OPERATION_NOT_FOUND`, a hash mismatch) and 0 otherwise.
- Exit code 2 covers:
  - a missing `oasdiff` executable;
  - an engine version mismatch (without `--allow-engine-version-mismatch`);
  - a URL without `--allow-network`;
  - `--require-spec` without a spec;
  - `--fail-on never` combined with another value;
  - an unreadable input.

`diff` takes a repeatable `--fail-on`:

```text
--fail-on breaking   # a change with breaking: 'yes'
--fail-on blocked    # any BLOCKED result
--fail-on unknown    # a change with breaking: 'unknown'
```

The values can be combined. `--fail-on never` disables policy failures and cannot be combined with other values. The default for `diff` is `blocked`.

The published `audit --fail-on mismatch|blocked|never` stays unchanged. A shared policy model can be unified later in a separate backward-compatible PR.

If only descriptions or formatting changed: empty `changes`, a report saying `No test-relevant changes found`, exit code 0. Example changes are listed separately because they can change generated payloads.

## CI integration

The architecture is CI-agnostic; the CLI is the contract.

- **First runnable example: GitHub Actions**, since this repository's CI already runs there.
- A Jenkinsfile (multibranch Pipeline or PR webhook) is an additional example.
- Compare the PR head with the **merge base**, not just the previous build.
- Archive `changes.json`, `test-impact.json` and a Markdown report. Fail on breaking changes only when the team's policy explicitly requests it (`--fail-on breaking`).
- For PRs from untrusted forks, do not expose secrets or run generated code with privileged credentials.

## Safety and acceptance criteria

- Changes to formatting, ordering, or descriptions alone should not generate new tests.
- A new required parameter creates parameter test cases; a changed response schema impacts contract tests; modified resource lifecycle edges flag dependent scenarios.
- Deletions and breaking changes require review, never automatic expectation updates.
- Missing specs, unresolved references, ambiguous mappings, and unconfirmed dependencies produce explicit BLOCKED/review items.
- Default mode performs static analysis only: no network calls, no writes outside `--out`, no CI secret access. Registry, manifest and generated files change only with explicit flags (`--apply-registry`, `--apply-generated`).
- CLI integration must be additive and preserve existing published npm commands.

## Implementation order

1. ~~**Baseline + semantic diff**~~ **done in #10** (first implementation PR, scope below).
2. ~~**Three-file suite layout in the generator**~~ **done in #3**: `functional.spec.ts` / `contract.spec.ts` / `scenarios.spec.ts` (Python: `test_functional.py` / `test_contract.py` / `test_scenarios.py`) replace `positive.spec.ts` / `negative.spec.ts`, using the [default mapping of checks](#test-suite-layout). No empty files.
3. Stable `operationUid` and case IDs in generated suites (**core done in #11**: case IDs and annotations / markers, `cases.json`, the manifest, snapshot metadata, `registry validate`, `manifest validate`, the vocabulary v1; still open: `registry merge`, aliases input, bootstrap of hand-written tests):
   - `_support/cases.json` and the generation manifest;
   - `caseId` annotations and the `api_case_id` marker;
   - snapshot metadata;
   - bootstrap for existing suites, including the migration from the `positive` / `negative` layout;
   - `registry validate` (syntax; schema-aware with `--spec`, `--require-spec`), `registry merge` (`--git-index` and explicit files, optional `--spec`), `manifest validate`;
   - `externalIdAliases` with `--id-aliases` / `--apply-registry`;
   - the case rule vocabulary v1 and case ID encoding/parsing (six parts).
4. Change-to-test impact mapping (`plan`): impact by suite type, `SuiteImpact` entries, dependency-graph traversal, `deps.json` validation, untracked tests.
5. Base/child integration: `--apply-generated`, patch proposals, `tsc` / `pytest --collect-only` validation.
6. GitHub Actions example, then Jenkinsfile; optional draft-PR integration; the `adapt` migration plan for untracked tests.

The semantic diff does not depend on API-object names: `operationUid` is the stable entity, while `operationId` and the generated method name are mutable attributes. So step 1 can proceed independently of PR #1. Steps 2–5 change the generator templates that PR #1 rewrote, so they start after PR #1 is merged (it is, and step 2 is done).

### First implementation PR

```text
api-test-agent diff [--base <file-or-url>] --head <file-or-url> --out <dir> \
  --format json|markdown \
  [--fail-on breaking|blocked|unknown|never]... \
  [--allow-network [--allow-host <hostname>]...] \
  [--allow-engine-version-mismatch]
```

Without `--base`, the [baseline](#baseline) sources are tried in order. In this PR the snapshot source always yields `BASE_SPEC_MISSING`, because snapshot metadata arrives in step 3. Without a registry, `operationUid`s come from the deterministic hash, and `stable-id-changed` / `retired-operation-reappeared` are not emitted yet.

Includes:

- `src/change/{types,baseline,normalize,oasdiff,map-changes,write-change-report}.ts`;
- `SUPPORTED_OASDIFF_VERSION` with its test, and the `oasdiff` preflight scan;
- network guards (`--allow-network`, `--allow-host`, denied hosts, limits);
- a JSON Schema for `changes.json`;
- fixtures and unit/integration tests covering:
  - identical specs and `$ref` refactoring;
  - operation add, remove and rename/move (rename detection thresholds);
  - path parameters (`normalizedPath`, `parameter-renamed`);
  - required, max/min, enum and type changes;
  - request vs. response direction;
  - OpenAPI 3.0 → 3.1;
  - a real Toolshop 3.1 fixture against the pinned `oasdiff`;
  - a missing snapshot;
  - duplicate `x-api-test-agent-id`;
  - `OASDIFF_UNSUPPORTED_CONSTRUCT`;
  - URL without `--allow-network`, missing `oasdiff`, version mismatch;
  - the exit code matrix, including combined `--fail-on`.

Excludes:

- changing generated tests or their layout;
- `plan` / test impact;
- dependency-graph traversal;
- `deps.json` updates;
- base/child integration;
- draft PRs;
- CI workflows;
- AI;
- running API tests;
- the three-file suite layout (step 2, already done in #3).
