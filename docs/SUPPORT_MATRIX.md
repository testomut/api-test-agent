# OpenAPI support matrix

What the generator derives from an OpenAPI document today, per keyword and per suite. Updated with every change that adds or closes a gap.

Legend: ✅ supported · 🟡 partial (limits listed) · ❌ missing · ⛔ not generated on purpose (unsafe or needs a business requirement; reported as a gap)

Baseline: `main` at 4c34a85 (audit of 2026-11-09). Each row names the stage of the coverage plan that changes it.

## Request body: negative contract cases (`contract.spec.ts`, `src/generate/negative.ts`)

| Keyword | State | Limits | Stage |
|---|---|---|---|
| `required` | 🟡 | top-level properties only | 3 |
| `type` | 🟡 | top-level only | 3 |
| `nullable` / `type: [.., null]` (null not allowed) | ❌ | | 3 |
| `enum` | 🟡 | top-level **string** only | 3 |
| `const` | ❌ | | 3 |
| `minLength` / `maxLength` | 🟡 | top-level only | 3 |
| `pattern` | ❌ | | 3 |
| `format` | ❌ | | 3 |
| `minimum` / `maximum` | 🟡 | top-level only | 3 |
| `exclusiveMinimum` / `exclusiveMaximum` | 🟡 | top-level; numeric (3.1) form only, not 3.0 boolean form | 3 |
| `multipleOf` | ❌ | | 3 |
| `minItems` / `maxItems` | 🟡 | top-level only | 3 |
| `uniqueItems` | ❌ | | 3 |
| `items` constraints | ❌ | | 3 |
| `minProperties` | 🟡 | body root only | 3 |
| `maxProperties` | ❌ | | 3 |
| `additionalProperties: false` | 🟡 | body root only | 3 |
| nested objects / arrays (`request.body#/a/b`, `/items/*/sku`) | ❌ | | 3 |
| `oneOf` / `anyOf` / `allOf` / `not` | ❌ | | 3 |
| `discriminator` | ❌ | | 3 |
| case limit | 🟡 | fixed 20 per operation, **silently truncated** | 3 |

## Parameters (`src/generate/negative.ts`, `templates.ts`)

| Target | State | Limits | Stage |
|---|---|---|---|
| query `required` | 🟡 | only when the spec gives a valid value | 4 |
| query `type` | 🟡 | number, integer, boolean | 4 |
| query `minimum` / `maximum` / exclusive | ✅ | | |
| query `minLength` / `maxLength` | ✅ | | |
| query `enum` (invalid value) | 🟡 | string only | 4 |
| query `const`, `pattern`, `format`, `multipleOf` | ❌ | | 4 |
| query arrays, `style` / `explode` | ❌ | | 4 |
| query boundary-valid values | ❌ | | 4 / 7 |
| path parameter constraints | ❌ | only unknown id → 404 | 4 |
| header parameters | ❌ | | 4 |
| cookie parameters | ❌ | | 4 |

## Functional (`functional.spec.ts`)

| Check | State | Limits | Stage |
|---|---|---|---|
| documented success status | ✅ | | |
| create returns an id | ✅ | confirmed chain | |
| read returns the created resource (same id) | ✅ | | |
| create response echoes sent fields | ❌ | | 7 |
| GET with each documented query `enum` value | ✅ | one test and one `accepted-value` case ID per value (`request.query#/<name>/<value>`), TypeScript and Python; values equal as strings are sent once; max 5 per parameter, 15 per operation | 2 ✔ |
| list contains the created resource | ❌ | | 7 / 8 |
| filter / search / pagination / sort | ⛔ | need a confirmed mapping (deps / scenario config) | 7 / 8 |
| boundary-valid values accepted | ❌ | | 7 |
| optional-field variants | ❌ | | 7 |
| response examples as requirements | ⛔ | examples are illustrations unless marked | 7 |

## Response contract (`src/contract/validator.ts`)

| Check | State | Limits | Stage |
|---|---|---|---|
| status, `NXX` ranges, `default` | ✅ | | |
| Content-Type of the matched response | ✅ | | |
| JSON schema (3.0 nullable, 3.1 / 2020-12, formats via ajv-formats) | ✅ | | |
| local / bundled `$ref` | ✅ | snapshot is bundled | |
| non-JSON media types | 🟡 | body not checked; not reported as unchecked | 5 |
| response headers (required, schema) | ❌ | | 5 |
| no body for `204` / `205` / `HEAD` / no `content` | ❌ | an unexpected body is accepted | 5 |
| `readOnly` / `writeOnly` | ❌ | | 5 |
| `discriminator` | 🟡 | `oneOf` validated, mapping ignored | 5 |
| contract tests exercise | 🟡 | success, 404 and 401 responses only | 5 / 6 |

## Documented error responses

| Status | State | Limits | Stage |
|---|---|---|---|
| 400 / 422 (invalid input) | ✅ | body + query | |
| 401 (no credentials) | ✅ | | |
| 401 (invalid token / API key) | ❌ | | 6 |
| 404 (unknown id) | ✅ | single trailing path parameter | |
| 403 (scope / role) | ⛔ | needs a reviewed role configuration | 6 |
| 405 | ❌ | | 6 |
| 409 (conflict) | ❌ | unique suffix only prevents it | 6 |
| 412 (precondition) | ❌ | | 6 |
| 415 (wrong Content-Type) | ❌ | | 6 |
| 429 (rate limit) | ⛔ | opt-in only | 6 |

## Scenarios (`scenarios.spec.ts`)

| Flow | State | Stage |
|---|---|---|
| create → read | ✅ | |
| create → update → read | ✅ (marked ASSUMPTION) | |
| create → delete → read 404 | ✅ | |
| create → list / search / filter | ❌ | 8 |
| create → duplicate create → 409 | ❌ | 6 / 8 |
| repeated delete, update / delete unknown | ❌ | 8 |
| login / refresh → authorized request | ❌ | 8 |
| parent → child, state transitions, idempotency key, bounded polling | ⛔ | need the reviewed scenario file | 8 |
| business scenario config with schema validation | ❌ | 8 |

## Valid data (`src/generate/sample.ts`)

| Keyword | State | Limits | Stage |
|---|---|---|---|
| `example`, `default`, `enum`, `const` | 🟡 | first value only | 7 |
| `examples` | 🟡 | first only | 7 |
| `oneOf` / `anyOf` | 🟡 | **first variant chosen silently** | 3 / 7 |
| `discriminator` | 🟡 | blocked (explicit) | 7 |
| `pattern` | 🟡 | blocked without an example (explicit) | 7 |
| `multipleOf` | ❌ | minimum used, may not be a multiple | 7 |
| formats | 🟡 | uuid, email, date-time, date, uri, url, hostname, ipv4 | 7 |
| `minItems`, nested objects / arrays | ✅ | | |
| `uniqueItems` | ❌ | copies one value `minItems` times | 7 |
| boundary-valid, optional-field, nullable variants | ❌ | | 7 |

## Reporting and CI

| Item | State | Stage |
|---|---|---|
| `coverage-gaps.json` per operation | 🟡 | counts + free-text reasons, no machine codes, no potential / dropped counts | 10 |
| unique case ID per physical test | ✅ | checked on the real run: Playwright JSON report annotations, pytest collection (`API_AGENT_CASES_OUT`) | 2 ✔ |
| CI: registry and manifest validation | ✅ | `registry validate --spec --require-spec`, `manifest validate`, TypeScript and Python | 2 ✔ |
| CI: no duplicate case IDs, every test registered | ✅ | plus: TypeScript and Python generate the same active cases | 2 ✔ |
| cases no longer generated | ✅ | become tombstones (`status: retired`), reactivated when generated again | 2 ✔ |
| CI: expected coverage gaps | ❌ | | 10 |
