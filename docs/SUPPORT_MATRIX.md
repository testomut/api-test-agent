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

## Request body: positive variants (`functional.spec.ts`, `src/generate/variants.ts`)

Create / update operations of a confirmed chain. Each variant is a valid payload (checked with ajv against the request schema before a test is written) that differs from the documented example in one documented way; the test expects the documented success status and a response that matches the contract, and removes what it created in `finally`.

| Variant | State | How / gap | Stage |
|---|---|---|---|
| only the required fields (`optional-omitted`, `request.body#`) | ✅ | optional fields removed outer first, each removal kept only while the payload stays valid (`minProperties`, dependent rules); never inside `oneOf` / `anyOf` / conditional subtrees; deps `fill` fields stay; nothing removable although optional fields exist → `CANNOT_ISOLATE_RULE` | D ✔ |
| another `oneOf` / `anyOf` branch (`variant`, `request.body#<pointer>/@<n>`) | ✅ | every branch the example does not match, with a sample of that branch; no valid sample, or the payload is not valid with it → `UNCOVERED_VARIANT` with the reason | D ✔ |

## Parameters (`src/generate/param-cases.ts`)

Every case is a valid request (each required query / header / cookie parameter with its documented value) in which exactly one parameter breaks exactly one rule (verified in `tests/unit/param-cases.test.ts` against the parameter schemas). The rules come from the same engine as request bodies. Expected result: a documented 400 / 422 / 4XX.

| Target | State | Limits / gap | Stage |
|---|---|---|---|
| required (missing) | ✅ | query, header, cookie; needs the documented value of every required parameter, else `MISSING_VALID_SAMPLE` and no cases | 4 ✔ |
| `type` | ✅ | number, integer, boolean (a string parameter cannot have a wrong type on the wire); an integer also gets a decimal inside its bounds (`request.<in>#/<name>/decimal`), which a lenient parser would round; with `multipleOf` > 1 or an `enum` → `CANNOT_ISOLATE_RULE` | 4 ✔, Q ✔ |
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
| boundary-valid values | ✅ | documented enum values, else the valid limits (min / max inside exclusive bounds and `multipleOf`, shortest / longest string), one `accepted-value` test each, status and response contract checked; more than 5 per parameter / 15 per operation → `CASE_LIMIT_REACHED` | 7 ✔, Q ✔ |
| the value is really sent | ✅ | every query case checks the request URL: the value under test as text, or absent for a missing one (a local schema violation proves nothing about the API); Python sends booleans as `true` / `false` like TypeScript | Q ✔ |

### Exploratory probes (`src/generate/probes.ts`)

Inputs a real client sends by mistake, for scalar query parameters of GET / HEAD operations. What the API must answer is not specified (or no rejection is documented), so a probe **never fails on the API's behavior**: it checks that the value went over HTTP and records the answer (status, documented or not, server error, contract match) as a test annotation and, during `--run`, in the report section "Exploratory query probes". A 5xx is flagged for a human, not reported as a defect. Rule `probe`, location `request.query#/<name>/<probe>`.

| Probe | For | Not generated when |
|---|---|---|
| `missing` | required parameters | the confirmed `required` case sends it |
| `empty` (`name=`) | all | a confirmed `minLength` ≥ 1 case covers it |
| `text` (`abc`, `maybe`) | integer / number / boolean | the confirmed `type` case covers it |
| `decimal` (`1.5`) | integer | the confirmed decimal case covers it |
| `zero`, `negative` | integer / number | a documented range makes it valid, or a confirmed minimum case covers it |
| `large` | integer / number (20 digits), string without `maxLength` (1000 characters) | a confirmed maximum / maxLength case covers it |
| `special` (`'"<>%;&`) | free-text strings | |
| `numeric` (`1`) | boolean | |
| `case` (another letter case of an enum value) | string enums | |

Write operations are never probed (`UNSAFE_LIVE_CHECK`); an operation with an unknown path value is not probed (`MISSING_RESOURCE_SOURCE`); more than 24 probes per operation → `CASE_LIMIT_REACHED`.

## Functional (`functional.spec.ts`)

| Check | State | Limits | Stage |
|---|---|---|---|
| documented success status | ✅ | | |
| create returns an id | ✅ | confirmed chain | |
| read returns the created resource (same id) | ✅ | | |
| create response returns sent fields | ✅ | only the fields a reviewed deps file names (`echoes`): the spec does not state it | 7 ✔ |
| update → read returns the new values | ✅ | scenario, marked ASSUMPTION | |
| delete → read 404 | ✅ | scenario | |
| GET with each documented query `enum` value | ✅ | one test and one `accepted-value` case ID per value | 2 ✔ |
| boundary-valid query values accepted | ✅ | minimum / maximum (inside exclusive bounds, on `multipleOf`), shortest / longest string (no pattern / format, ≤ 64 chars); one test and case ID each | 7 ✔ |
| list contains the created resource, filter / search / pagination / sort | ⛔ | need a confirmed mapping of list fields and parameters (not in the spec) | 8 (gap) |
| optional-field variants of a create payload | ❌ | | |
| response examples as requirements | ⛔ | examples are illustrations, never asserted | |

## Response contract (`src/contract/validator.ts`, `src/contract/contract.py`)

The TypeScript and Python validators apply the same rules; `tests/unit/validator.test.ts` runs one table of cases through both and requires identical results.

| Check | State | Limits | Stage |
|---|---|---|---|
| status, `NXX` ranges, `default` | ✅ | | |
| Content-Type of the matched response, media type parameters ignored, `type/*` and `*/*` | ✅ | an undocumented type is reported before an empty body | 5 ✔ |
| JSON schema (3.0 nullable, 3.1 / 3.2 JSON Schema 2020-12, formats) | ✅ | | |
| local / bundled `$ref` | ✅ | the snapshot is bundled | |
| response headers | ✅ | required ones present; documented ones match their schema (integer / number / boolean coerced, arrays comma-separated, style simple); `Content-Type` ignored as OpenAPI says | 5 ✔ |
| no body for `204` / `205` / `304`, `HEAD` | ✅ | a body that arrives anyway is `unexpected-body` (RFC 9110) | 5 ✔ |
| a response without `content` | ✅ | means "not described", not "no body": a body is accepted and not checked, with a note and `MISSING_RESPONSE_SCHEMA` | 5 ✔ |
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
| 401 (expired token) | ✅ | deps `auth.expired.credentialEnv`: the variable holding an expired credential (never the value in the file); the same safe request as the invalid-credential case; skipped with the reason when the variable is unset; rule `expired-credentials` | D ✔ |
| 403 (scope / role) | ✅ | deps `auth.forbidden` (`credentialEnv` + the operations that must refuse that account): GET / HEAD with documented path values only; a write → `UNSAFE_LIVE_CHECK`, unknown path values → `MISSING_RESOURCE_SOURCE`, an operation named without a documented 403 → `INVALID_REVIEWED_CONFIG`; without the section `UNCONFIRMED_BUSINESS_RULE` | D ✔ |
| 404 (unknown id) | ✅ | single trailing path parameter | |
| 405 | ✅ | a GET to a path that defines no GET (one case per path); a path with GET → `UNSAFE_LIVE_CHECK` (any other undocumented method could change data) | 6 ✔ |
| 409 (conflict) | ✅ | create twice with the same payload, only when the deps file names `conflictOn` fields (a reviewed business rule); both records removed in `finally`; otherwise `UNCONFIRMED_BUSINESS_RULE` | 6 ✔ |
| 412 (precondition) | ✅ | a non-matching `If-Match` / `If-Unmodified-Since` header (when documented) on a resource the test creates and removes; no such header → `UNCONFIRMED_BUSINESS_RULE` | 6 ✔ |
| 415 (wrong Content-Type) | ✅ | the documented body as `text/plain`, create / update with confirmed cleanup; otherwise `MISSING_CLEANUP` | 6 ✔ |
| 429 (rate limit) | ⛔ | `UNSAFE_LIVE_CHECK`: never exercised (opt-in with a request budget is not implemented) | 6 ✔ (gap) |
| other documented 4xx | ⛔ | `UNREACHABLE_RESPONSE_STATUS` | 6 ✔ (gap) |

## Scenarios (`scenarios.spec.ts`, `src/scenarios/dsl.ts`)

CRUD flows come from confirmed dependencies (OpenAPI links or the deps file). Business flows are never guessed from paths: they come from a reviewed scenarios file (`--scenarios`, JSON Schema `schemas/scenarios.schema.json`, `scenarios validate --spec`): steps in order with phases, parameters and bodies with `{var}` values saved by earlier steps, the documented status each step must get, and cleanup steps run in `finally` (failures reported). The case ID comes from the scenario's external `id`, never from the title.

| Flow | State | Source / limits | Stage |
|---|---|---|---|
| create → read | ✅ | confirmed chain | |
| create → update → read | ✅ | confirmed chain; marked ASSUMPTION | |
| create → delete → read 404 | ✅ | confirmed chain | |
| delete → repeated delete → 404 | ✅ | confirmed chain, delete documents 404 | 8 ✔ |
| create → duplicate create → 409 | ✅ | deps `conflictOn` | 6 ✔ |
| update / delete unknown resource → 404 | ✅ | functional `not-found` cases | |
| business flows (login → request, parent → child, state transitions, negative transitions, idempotency key, …) | ✅ | reviewed scenarios file; strict validation: operations exist, parameters exist, every non-cleanup step names a documented status, every `{var}` is saved earlier, a writing scenario has cleanup, the primary is an action, IDs unique | 8 ✔ |
| create → list → update → list → delete → list | ✅ | reviewed deps `collection` mapping (see Collections); bounded polling | C ✔ |
| create → list / search / filter, pagination, sort | ✅ | reviewed deps `collection` mapping (see Collections); other list shapes as a reviewed business scenario | C ✔ |
| eventual consistency with bounded polling | 🟡 | collection checks: `consistency.pollTimeoutMs` (≤ 60 s) / `pollIntervalMs`; the scenario DSL has no polling step yet | C ✔ |
| refresh token → request | 🟡 | as a reviewed scenario with explicit steps | 8 ✔ |

## Collections (`src/generate/collection*.ts`, `src/fixtures/`)

A list operation is tested deeply only from a reviewed `collection` mapping in the deps file (next to the resource's CRUD chain). Nothing is inferred from names: every pointer, query parameter, sort value and paging parameter is checked against the spec, and a mismatch is an `INVALID_REVIEWED_CONFIG` gap instead of tests. A GET collection without a mapping gets an `UNCONFIRMED_BUSINESS_RULE` gap; a single resource with an array field is not a collection.

```json
"collection": {
  "operationId": "listItems", "items": "/items", "id": "/id",
  "fields": { "/name": "exact", "/price": "tolerance:0.001", "/tags": "exact", "/createdAt": "ignore" },
  "unique": ["/id"],
  "filters": [{ "param": "tag", "field": "/tags", "match": "contains" }],
  "sorts": [{ "param": "sort", "value": "-price", "field": "/price", "order": "desc" }],
  "page": { "style": "offset", "offsetParam": "offset", "limitParam": "limit", "maxPages": 20 },
  "consistency": { "pollTimeoutMs": 5000, "pollIntervalMs": 250 },
  "deletedDisappears": true
}
```

Page-number paging: `{ "style": "page", "pageParam": "page", "sizeParam": "per_page" }`, or, when the API fixes the size and has no size parameter, `{ "style": "page", "pageParam": "page", "size": 9 }`. `"strategy": "read-only"` forbids creating records for these checks even when a create is confirmed (shared environments). Sort values come from the reviewed mapping; the spec can only rule one out with an `enum`.

Strategy per list operation (recorded in `coverage-gaps.json` → `collection.strategy` / `strategies` / `reasons`):

| Strategy | When | What it checks |
|---|---|---|
| A · create & verify | confirmed create + delete; an isolating filter whose field can carry a unique marker | the test creates its own records (marker in the filter field), reads only them, removes them in `finally`; non-trivial datasets: 2 records for a filter (one must be left out), 3 with distinct values created out of order for a sort, page size + 1 for paging |
| B · approved fixtures | `--fixtures <dir>` holds `<operationId>.json` approved by a person | every approved element is listed, each field by policy (`exact`, `tolerance:<n>`, `schema` = present, `ignore`); `exhaustive` = nothing else |
| C · read-only | no confirmed create / cleanup, no isolating filter, or `"strategy": "read-only"` | the same properties on existing data; filters with up to 5 values that occur in the list, each result also a subset of the unfiltered list (re-read once, shared data moves); a test without enough data is skipped with the reason |
| contract-only | no mapping | schema and status only; the gap says what is missing |

| Assertion | State | Notes |
|---|---|---|
| created resource is listed (`collection-contains`) with its persisted fields | ✅ | strategy A; field policies |
| filter returns the match and leaves out the non-match, all results match (`filter`) | ✅ | `equals` / `contains`; enum filters with an isolating marker |
| search (`"match": "search"`: the string field contains the value, ignoring case) | ✅ | controlled: the query in upper case, the data in lower case; read-only: prefixes of existing values; no subset check when the search parameter is required (there is no unfiltered list) |
| descending is the ascending order reversed (`sort-reverse`) | ✅ | for every asc / desc pair on one field; controlled: the test's records; read-only: the values (ties keep their place), read once more on a mismatch |
| total and metadata (`total`: a JSON pointer in the response) | ✅ | the same total on every page and equal to the number of resources listed; read-only skipped when there are more than `maxPages` pages; without `total` → `UNCONFIRMED_BUSINESS_RULE` |
| several list operations of one resource (`"collections": [...]`) | ✅ | each with its own mapping; an operation mapped twice → `INVALID_REVIEWED_CONFIG`; a lifecycle that cannot find the updated resource (required parameter, update changes the isolating field) → `CANNOT_ISOLATE_RULE` |
| a filter only narrows: no resource the unfiltered list does not show (`filter`, read-only) | ✅ | values that occur in the list only: a value that only hidden resources have cannot be reached read-only |
| range filters (`between=price,10,30`), boolean flags with a default scope (`is_rental`) | ❌ | not mapped yet |
| sort order (`sort`) | ✅ | one case per documented sort value; plain comparison (code points / numbers): the API must document that order |
| page size, no duplicates across pages, union holds every record (`pagination`) | ✅ | offset and page/size styles; cursor paging ❌ (not yet) |
| uniqueness (`unique`) | ✅ | |
| approved fixture (`fixture`) | ✅ | strategy B |
| create → list → update → list → delete → list | ✅ | scenario of the list operation; the last step only with `deletedDisappears` |
| bounded polling | ✅ | only with `consistency`; never longer than `pollTimeoutMs` (≤ 60 s); otherwise one read |
| fixture capture / refresh | ✅ | `fixtures capture` writes candidates only; `fixtures refresh --draft-pr` proposes a candidate in one Draft PR per operation; approved files are never written by the agent |

Defect detection on a real API: Toolshop's deliberately defective build (`api-with-bugs.practicesoftwaretesting.com`) returns rental products for `by_brand=1` that its product list never shows. The read-only `by_brand` test fails on it (`by_brand=1 returns resources the unfiltered collection does not show: 27, 28, 29`) and passes on the regular build, in TypeScript and Python. `by_category=12` has the same defect but only rentals carry that category, so a read-only test cannot reach it.

Defect detection on the demo API (`scripts/mutation-check.ts --show` lists which tests caught each defect; TypeScript and Python identical). 17 faults in CI: the list defects below, `require-optional`, `accept-expired`, `ignore-suspension`, and the parameter / collection faults `ignore-max`, `loose-types`, `ignore-enum`, `ignore-required`, `truncate-decimal` (limit=20.5 becomes 20), `wrong-total`, `drop-update` (the update is not stored), `broken-search`. The previous release caught 14/17 on the same spec (missed `wrong-total`, `broken-search`, `truncate-decimal`). Beyond the list defects below, the suite must also catch `require-optional` (an optional field is required), `accept-expired` (an expired token is accepted) and `ignore-suspension` (a refused account gets 200): 9/9 in CI; the generator of the previous release caught 7/9 on the same spec (both auth defects missed, `require-optional` only by chance, through a reviewed business scenario).



| Injected defect (`DEMO_FAULT`) | Previous generator (65 tests) | Collection tests |
|---|---|---|
| filter ignored | missed | detected |
| sort reversed | missed | detected |
| created record hidden from the list | missed | detected |
| every record listed twice | missed | detected |
| wrong field value in the list | missed | detected |
| pages overlap (off-by-one offset) | missed | detected |

## Maintenance (`maintain`, `src/maintain.ts`)

| Step | State | Notes |
|---|---|---|
| detect changed operations | ✅ | `diff` (oasdiff); without a baseline or the engine the whole suite is regenerated and the summary says so |
| regenerate | ✅ | deterministic: unaffected files keep their bytes; files whose only change is the spec hash in the header are listed separately |
| validate | ✅ | case registry against the head spec, generation manifest; no PR when validation fails |
| Draft PR | ✅ | one bot branch per suite (`api-agent/maintain-<tests dir>`); an open PR is updated, never duplicated; never merged |
| summary | ✅ | changed operations, files and cases added / updated / removed / retired, expectations old → new, fixtures, reviewed configuration that no longer matches, coverage gaps before → after, validation |

## Valid data (`src/generate/sample.ts`)

| Keyword | State | Limits | Stage |
|---|---|---|---|
| `example`, `default`, `enum`, `const` | 🟡 | first value only | |
| `examples` | 🟡 | first only | |
| `oneOf` / `anyOf` | ✅ | the example's branch in every test; each other branch with a valid sample in its own positive test (see "Request body: positive variants"); the rest `UNCOVERED_VARIANT` | D ✔ |
| `discriminator` | 🟡 | blocked with an explicit reason | |
| `pattern` | 🟡 | blocked without an example (explicit reason) | |
| `multipleOf` | ✅ | the smallest multiple inside the bounds | 7 ✔ |
| exclusive bounds | ✅ | 3.1 numeric and 3.0 boolean form, combined with `minimum` | 7 ✔ |
| formats | 🟡 | uuid, email, date-time, date, uri, url, hostname, ipv4 | |
| `minItems`, nested objects / arrays | ✅ | | |
| `uniqueItems` | ✅ | distinct elements (enum values, suffixed strings, stepped numbers); otherwise blocked with the reason | 7 ✔ |
| unique values on a documented 409 | ✅ | suffix that respects enum / const / format / pattern / maxLength | |

## Reporting and CI

| Item | State | Notes | Stage |
|---|---|---|---|
| `coverage-gaps.json` | ✅ | summary (operations, generated tests per suite, gaps by code); per operation: gaps with code and location, per-suite generated count and missing code, positive-blocked code, body cases potential / generated / dropped, unchecked statuses (with the reason code), unchecked request media types, unchecked security alternatives | 10 ✔ |
| machine codes | ✅ | `MISSING_VALID_SAMPLE`, `MISSING_RESOURCE_SOURCE`, `MISSING_CLEANUP`, `MISSING_RESPONSE_SCHEMA`, `UNSUPPORTED_SCHEMA_KEYWORD`, `UNSUPPORTED_MEDIA_TYPE`, `UNCONFIRMED_BUSINESS_RULE`, `UNCOVERED_VARIANT`, `CANNOT_ISOLATE_RULE`, `CASE_LIMIT_REACHED`, `UNREACHABLE_RESPONSE_STATUS`, `UNSAFE_LIVE_CHECK`, `DEPRECATED_OPERATION`, `NO_DOCUMENTED_REJECTION`, `INVALID_REVIEWED_CONFIG` (`src/generate/coverage.ts`) | 10 ✔ |
| unique case ID per physical test | ✅ | checked on the real run: Playwright JSON report annotations, pytest collection (`API_AGENT_CASES_OUT`) | 2 ✔ |
| cases no longer generated | ✅ | tombstones (`status: retired`), reactivated when generated again | 2 ✔ |
| CI: registry and manifest validation | ✅ | `registry validate --spec --require-spec`, `manifest validate`, TypeScript and Python | 2 ✔ |
| CI: no duplicate case IDs, every test registered | ✅ | | 2 ✔ |
| CI: TypeScript / Python parity | ✅ | the same active cases for the demo API and for the synthetic fixture | 9 ✔ |
| CI: the synthetic fixture compiles | ✅ | `tests/fixtures/coverage/kitchen-sink.yaml` generated in both languages: `tsc`, `py_compile`, valid registry | 6 ✔ |
| CI: expected coverage gaps | ✅ | demo API (`demo-api/expected-gaps.json`) in CI; the synthetic fixture in unit tests | 10 ✔ |
| CI: coverage baseline | ✅ | `ci/coverage-baseline.{demo,kitchen-sink}.json`: every active case ID and every gap (code + operation + location); a lost case or a gap the baseline does not list fails until the PR updates the baseline (`scripts/coverage-summary.ts --write-baseline`) | D ✔ |
| CI: Python fixtures are never reassigned | ✅ | a test that assigns to its own fixture (e.g. `items, totals = ...` with the `items` resource fixture) fails the gate: its cleanup would hit the wrong object | Q ✔ |
| CI: cleanup of write tests | ✅ | every generated test that creates data removes it in `finally`, a fixture teardown, or `removeIfCreated` right after the request and before any assertion (`src/report/quality-gates.ts`), TypeScript and Python | D ✔ |
| CI: coverage summary | ✅ | per operation: suites, active case IDs, documented statuses checked, gaps with code and location; Markdown + JSON artifact `coverage-summary`, also in the job summary | D ✔ |
| unchecked-status codes | ✅ | the actual reason: a status of an operation no request is sent to has the success call's reason (e.g. `MISSING_CLEANUP`), an unchecked success status the reason the success call is blocked (e.g. `MISSING_RESOURCE_SOURCE`) | D ✔ |
| CI: fault injection | ✅ | `scripts/mutation-check.ts`: the demo list suite must be clean without a fault and fail under each of 6 `DEMO_FAULT` modes, TypeScript and Python | C ✔ |
| CI: maintenance | ✅ | `maintain` on a changed demo spec: regenerated, validated, the stale reviewed mapping reported | C ✔ |
| README | ✅ | "What is covered, and what is not": spec-derived vs needs confirmation vs never generated | 10 ✔ |
