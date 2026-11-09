# OpenAPI support matrix

What the generator derives from an OpenAPI document today, per keyword and per suite. Updated with every change that adds or closes a gap.

Legend: ✅ supported · 🟡 partial (limits listed) · ❌ missing · ⛔ not generated on purpose (unsafe or needs a business requirement; reported as a gap)

Baseline: `main` at 4c34a85 (audit of 2026-11-09). Each row names the stage of the coverage plan that changes it.

## Request body: negative contract cases (`contract.spec.ts`, `src/generate/body-cases.ts`)

Recursive from a valid payload; every case breaks exactly one rule (verified with ajv in `tests/unit/body-cases.test.ts`: one error, the expected keyword, the expected instance path). Locations are JSON pointers at any depth, `*` for array elements (the first element stands for all). A rule that cannot be broken alone is a gap with a code, never a guess.

| Keyword | State | Limits / gap | Stage |
|---|---|---|---|
| `required` | ✅ | any depth; a required field without a valid sample → `MISSING_VALID_SAMPLE` | 3 ✔ |
| `type` | ✅ | any depth; skipped for `enum` / `const` fields (`CANNOT_ISOLATE_RULE`: the enum case covers it) | 3 ✔ |
| `nullable` / `type: [.., null]` | ✅ | `null` where null is not allowed (rule `nullable`) | 3 ✔ |
| `enum` | ✅ | string, number, integer, boolean; an enum covering all values → gap | 3 ✔ |
| `const` | ✅ | scalars | 3 ✔ |
| `minLength` / `maxLength` | ✅ | gap when `pattern` / `format` / `enum` / `const` would break too | 3 ✔ |
| `pattern` | ✅ | a simple non-matching string within the length limits; otherwise gap | 3 ✔ |
| `format` | ✅ | email, uuid, date-time, date, time, uri, url, hostname, ipv4, ipv6; others → `UNSUPPORTED_SCHEMA_KEYWORD` | 3 ✔ |
| `minimum` / `maximum` | ✅ | step = `multipleOf` when present; gap when the value would break another bound | 3 ✔ |
| `exclusiveMinimum` / `exclusiveMaximum` | ✅ | 3.1 numeric and 3.0 boolean form | 3 ✔ |
| `multipleOf` | ✅ | a neighbour of the sample value inside the bounds | 3 ✔ |
| `minItems` / `maxItems` | ✅ | `maxItems` with `uniqueItems` → gap (repeating breaks uniqueness) | 3 ✔ |
| `uniqueItems` | ✅ | duplicate first element; gap when it would exceed `maxItems` | 3 ✔ |
| `items` constraints | ✅ | recursive through the first element; an empty sample array → gap | 3 ✔ |
| `minProperties` / `maxProperties` | ✅ | drops optional properties only / adds extra ones; gap when required or `additionalProperties: false` would break | 3 ✔ |
| `additionalProperties: false` | ✅ | any depth | 3 ✔ |
| nested objects / arrays | ✅ | `request.body#/customer/address/city`, `request.body#/items/*/price`, depth ≤ 12 | 3 ✔ |
| `allOf` | ✅ | object parts merged | 3 ✔ |
| `oneOf` / `anyOf` / `not` / `discriminator` | ⛔ | `UNSUPPORTED_SCHEMA_KEYWORD` at that location: a broken value may still match another branch | 3 ✔ (gap) |
| `readOnly` | ✅ | not sent, no case | 3 ✔ |
| case limit | ✅ | `--max-cases` (default 60 per operation); potential / generated / dropped in `coverage-gaps.json`, each dropped case as `CASE_LIMIT_REACHED` | 3 ✔ |

## Parameters (`src/generate/param-cases.ts`)

Every case is a valid request (each required query / header / cookie parameter with its documented value) in which exactly one parameter breaks exactly one rule (verified in `tests/unit/param-cases.test.ts` against the parameter schemas). The rules come from the same engine as request bodies. Expected result: a documented 400 / 422 / 4XX.

| Target | State | Limits / gap | Stage |
|---|---|---|---|
| required (missing) | ✅ | query, header, cookie; needs the documented value of every required parameter, else `MISSING_VALID_SAMPLE` and no cases | 4 ✔ |
| `type` | ✅ | number, integer, boolean (a string parameter cannot have a wrong type on the wire) | 4 ✔ |
| `enum`, `const` | ✅ | | 4 ✔ |
| `pattern`, `format` | ✅ | as for bodies | 4 ✔ |
| `minimum` / `maximum` / exclusive / `multipleOf` | ✅ | | 4 ✔ |
| `minLength` / `maxLength` | ✅ | | 4 ✔ |
| arrays: `minItems` / `maxItems` / `uniqueItems` | ✅ | query `form` (explode true → repeated keys, false → comma), `spaceDelimited`, `pipeDelimited`; header `simple` | 4 ✔ |
| array item / object member constraints in parameters | ⛔ | `UNSUPPORTED_SCHEMA_KEYWORD` | 4 ✔ (gap) |
| `deepObject`, object parameters, array cookies | ⛔ | `UNSUPPORTED_SCHEMA_KEYWORD` | 4 ✔ (gap) |
| header parameters | ✅ | `Authorization`, `Content-Type`, `Accept` are not parameters (OpenAPI) | 4 ✔ |
| cookie parameters | ✅ | sent in the `Cookie` header | 4 ✔ |
| path parameters | ✅ | type, format, pattern, enum, length; on write operations numeric bounds → `UNSAFE_LIVE_CHECK` (an out-of-range id could address a real record); other path parameters need documented values (`MISSING_RESOURCE_SOURCE`); not on operations whose body is required | 4 ✔ |
| required header / cookie in every generated call | ✅ | positive, 404, 401, body and parameter cases; a required one without a documented value blocks the operation with its reason | 4 ✔ |
| boundary-valid values | ❌ | | 7 |

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

## Response contract (`src/contract/validator.ts`, `src/contract/contract.py`)

The TypeScript and Python validators apply the same rules; `tests/unit/validator.test.ts` runs one table of cases through both and requires identical results.

| Check | State | Limits | Stage |
|---|---|---|---|
| status, `NXX` ranges, `default` | ✅ | | |
| Content-Type of the matched response, media type parameters ignored, `type/*` and `*/*` | ✅ | an undocumented type is reported before an empty body | 5 ✔ |
| JSON schema (3.0 nullable, 3.1 / 3.2 JSON Schema 2020-12, formats) | ✅ | | |
| local / bundled `$ref` | ✅ | the snapshot is bundled | |
| response headers | ✅ | required ones present; documented ones match their schema (integer / number / boolean coerced, arrays comma-separated, style simple); `Content-Type` ignored as OpenAPI says | 5 ✔ |
| no body for `204` / `205` / `304`, `HEAD`, responses without `content` | ✅ | a body that arrives anyway is `unexpected-body` | 5 ✔ |
| empty body where a schema is documented | ✅ | `empty-body` (JSON `null` is a body) | 5 ✔ |
| text media types with a schema | ✅ | the text is validated as a string | 5 ✔ |
| other media types (XML, binary, …) | ⛔ | not checked: a note in the test report (Playwright annotation `contract-note`, pytest warning) and `UNSUPPORTED_MEDIA_TYPE` in `coverage-gaps.json` | 5 ✔ (gap) |
| a response without a schema | ⛔ | not checked: note + `MISSING_RESPONSE_SCHEMA` | 5 ✔ (gap) |
| `writeOnly` | ✅ | must not appear in a response; never required in a response | 5 ✔ |
| `readOnly` | ✅ | not sent in request cases (stage 3) | 3 ✔ |
| `discriminator` | 🟡 | `oneOf` validated; the mapping is not used | |
| contract tests exercise | 🟡 | success, 404 and 401 responses; more in stage 6 | 6 |

## Documented error responses (`src/generate/error-cases.ts`)

A case is generated only when the request that triggers the error is safe and the error is documented for the operation; everything else is a gap in `coverage-gaps.json` at `response.status#/<code>`.

| Status | State | How / gap | Stage |
|---|---|---|---|
| 400 / 422 (invalid input) | ✅ | body and parameter cases | 3–4 ✔ |
| 401 (no credentials) | ✅ | `publicApi` / `anonymous_api` | |
| 401 (invalid credentials) | ✅ | a certainly invalid credential of the operation's scheme: HTTP bearer / OAuth2 / OpenID Connect (`Bearer api-agent-invalid-token`), HTTP basic, API key in header / query / cookie; an unknown scheme → `UNSUPPORTED_SCHEMA_KEYWORD` | 6 ✔ |
| 401 (expired token) | ⛔ | needs a configured expired token | 6 (gap) |
| 403 (scope / role) | ⛔ | `UNCONFIRMED_BUSINESS_RULE`: needs a reviewed account that must be refused | 6 ✔ (gap) |
| 404 (unknown id) | ✅ | single trailing path parameter | |
| 405 | ✅ | a GET to a path that defines no GET (one case per path); a path with GET → `UNSAFE_LIVE_CHECK` (any other undocumented method could change data) | 6 ✔ |
| 409 (conflict) | ✅ | create twice with the same payload, only when the deps file names `conflictOn` fields (a reviewed business rule); both records removed in `finally`; otherwise `UNCONFIRMED_BUSINESS_RULE` | 6 ✔ |
| 412 (precondition) | ✅ | a non-matching `If-Match` / `If-Unmodified-Since` header (when documented) on a resource the test creates and removes; no such header → `UNCONFIRMED_BUSINESS_RULE` | 6 ✔ |
| 415 (wrong Content-Type) | ✅ | the documented body as `text/plain`, create / update with confirmed cleanup; otherwise `MISSING_CLEANUP` | 6 ✔ |
| 429 (rate limit) | ⛔ | `UNSAFE_LIVE_CHECK`: never exercised (opt-in with a request budget is not implemented) | 6 ✔ (gap) |
| other documented 4xx | ⛔ | `UNREACHABLE_RESPONSE_STATUS` | 6 ✔ (gap) |

## Scenarios (`scenarios.spec.ts`)

| Flow | State | Stage |
|---|---|---|
| create → read | ✅ | |
| create → update → read | ✅ (marked ASSUMPTION) | |
| create → delete → read 404 | ✅ | |
| create → list / search / filter | ❌ | 8 |
| create → duplicate create → 409 | ✅ (deps `conflictOn`) | 6 ✔ |
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
