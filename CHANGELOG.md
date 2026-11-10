# Changelog

## Unreleased

- **Query parameters and GET collections** (docs/SUPPORT_MATRIX.md):
  - confirmed: a decimal case for integer parameters (inside the documented bounds, so only the type is broken); every query case checks that the value really went over HTTP; accepted values also check the response contract; values over the limits are `CASE_LIMIT_REACHED` gaps instead of being dropped silently; Python sends query booleans as `true` / `false`;
  - exploratory probes for scalar query parameters of GET / HEAD operations (empty, text, decimal, zero, negative, large, special characters, another spelling of a boolean or enum value, a missing required parameter): deduplicated against confirmed cases and the documented range, never failing on the API's behavior, recorded in the report (`exploratory.jsonl`, "Exploratory query probes");
  - collections: `"match": "search"` (case-insensitive substring), `total` (the same on every page and equal to the number listed), `sort-reverse` (descending is ascending reversed), several mappings per resource (`"collections": [...]`);
  - case ID vocabulary v5: `sort-reverse`, `total`, `probe`, the decimal `type` case;
  - CI gate: a Python test that reassigns its own fixture fails (found here: a generated test shadowed the `items` resource fixture, so its cleanup would not have run);
  - demo API: `GET /items/search` (required `q`), and the faults `ignore-max`, `loose-types`, `ignore-enum`, `ignore-required`, `truncate-decimal`, `wrong-total`, `drop-update`, `broken-search`; fault injection 17/17 in TypeScript and Python (the previous generator: 14/17 on the same spec).
- **Coverage depth** (docs/SUPPORT_MATRIX.md):
  - positive request-body variants for create / update of a confirmed chain: only the required fields, and every other `oneOf` / `anyOf` branch with a valid sample; each checked with ajv before a test is written, cleanup in `finally`; closes `UNCOVERED_VARIANT` where a branch can be sent;
  - reviewed auth cases from a deps `auth` section (environment variable names only): 403 for the operations named (`auth.forbidden`), 401 with an expired credential (`auth.expired`); skipped with the reason when the variable is unset; mismatches with the spec are `INVALID_REVIEWED_CONFIG`;
  - unchecked-status codes state the actual reason (`MISSING_CLEANUP` for an operation no request is sent to, the success call's blocking reason for its status) instead of `NO_DOCUMENTED_REJECTION` / `UNCONFIRMED_BUSINESS_RULE`;
  - case ID vocabulary v4: `optional-omitted`, `variant`, `expired-credentials`;
  - CI quality gates (`scripts/coverage-summary.ts`): reviewed baselines of active case IDs and exact gaps (`ci/coverage-baseline.*.json`), TypeScript / Python parity, guaranteed cleanup of write tests, a per-operation coverage summary as an artifact;
  - demo API: a documented 403 on `GET /me` (suspended account), fixed expired / suspended sessions for the reviewed auth cases, and three more fault modes (`require-optional`, `accept-expired`, `ignore-suspension`); fault injection runs over `items` and `me`: 9/9 in TypeScript and Python (the previous generator: 7/9 on the same spec).
- **Collection testing** (docs/SUPPORT_MATRIX.md, "Collections"):
  - reviewed deps `collection` mapping, checked strictly against the spec (`INVALID_REVIEWED_CONFIG` gap on a mismatch);
  - strategy A (create & verify): controlled datasets with a unique marker in an isolating filter, cleanup in `finally`; strategy C (read-only) with explicit skips; strategy recorded per list operation in `coverage-gaps.json`;
  - assertions in TypeScript and Python alike: contains / not contains, persisted fields by policy (exact, tolerance, schema, ignore), all match a filter, unique by, sorted by, page size, no duplicates across pages; offset and page/size paging; bounded polling for documented eventual consistency;
  - create → list → update → list → delete → list scenario on the list operation;
  - case ID vocabulary v3: `collection-contains`, `filter`, `sort`, `pagination`, `unique`, `fixture`.
- **Approved fixtures (strategy B):** `generate --fixtures <dir>` compares a list with `<operationId>.json` approved by a person; `fixtures capture` writes candidates only; `fixtures refresh --draft-pr` proposes a changed candidate in one Draft PR per operation (updated, never duplicated). Approved files are never written by the agent.
- **`maintain`:** spec diff → deterministic regeneration → registry and manifest validation → one Draft PR per suite with a summary (changed operations, files and cases, expectations old → new, fixtures, stale reviewed configuration, gaps before → after). Never merges; no PR when validation fails or nothing changed.
- **Fault injection:** the demo API simulates six list defects (`DEMO_FAULT`); `scripts/mutation-check.ts` runs a generated suite against each, and CI requires 6/6 detected in TypeScript and Python. The previous generator detected 0/6.
- Demo API: `offset`, `tag` and `sort` on `GET /items`; two reference items tagged `catalog` (the approved demo fixture).
- **Shared environments (found on Toolshop):** `"strategy": "read-only"` in a collection mapping; page-number paging with a fixed page size; read-only checks of a public list go through `publicApi` (no login); read-only filter tests take up to 5 values from the list and require the filtered result to be a subset of the unfiltered list, which catches the rental leak of Toolshop's defective build; a `sort` case ID may carry a reviewed value the spec does not enumerate.
- **Test account `auto`:** `API_TEST_ACCOUNT=auto` / `--test-account auto` uses the `.env` account and registers a new one only when it is missing or refused (401 / 403 / 422), e.g. after Toolshop reset its data; the agent registers once before `--run` and the generated tests reuse that account; with the generated `_support/global-setup.ts` as Playwright's `globalSetup` (added by `init`), a standalone run decides once in the main process, so a run registers at most one account even when Playwright restarts workers after failures; without it, at most one per worker. `.env` is never changed. Python suites (conftest) support `new` and `auto` too, with at most one registration per pytest session.
- Fixes: a GET of a single resource with an array field is no longer reported as an unconfigured collection; hand-written `_support/api/*Api.ts` stay in the generation manifest after the first run.

- **Coverage completeness** (see docs/SUPPORT_MATRIX.md):
  - one physical test → one stable case ID (vocabulary v2: `accepted-value`, `invalid-credentials`, `method-not-allowed`, `precondition-failed`), checked on the real run (Playwright report, pytest collection); cases no longer generated become tombstones;
  - recursive request-body negative cases at any depth, exactly one broken rule each (verified with ajv), configurable limit `--max-cases` with dropped cases reported;
  - query / header / cookie / path parameter cases, array serialization by style / explode, required header / cookie parameters sent in every call;
  - stricter response contract in TypeScript and Python alike: headers, no body for 204 / 205 / 304 / HEAD / no content, empty body, text schemas, writeOnly; what is not checked is said;
  - documented errors with safe triggers: 401 invalid credentials, 405, 409 (deps `conflictOn`), 412, 415; 403 / 429 / others as gaps;
  - boundary-valid query values, deps `echoes`, sampler fixes (multipleOf, exclusive bounds, uniqueItems), uncovered oneOf / anyOf branches reported;
  - reviewed business scenarios (`--scenarios`, `scenarios validate`, schemas/scenarios.schema.json) and repeated delete;
  - `coverage-gaps.json`: summary by machine code, per-suite status, unchecked statuses / request media types / security alternatives;
  - CI: case-ID checks, registry and manifest validation, TypeScript / Python parity, the synthetic fixture must compile, expected coverage gaps.
- **Stable case IDs** (step 3 of docs/OPENAPI_CHANGE_TRIGGER.md, core): every generated test carries `ata:<subject>:<suite>:<polarity>:<location>:<rule>` (Playwright annotation `caseId`, pytest marker `api_case_id`). `generate` writes `_support/cases.json` (operations, cases, CRUD scenario definitions; existing UIDs kept, removed operations retired, never rebuilt), `_support/generation-manifest.json` (file ownership and canonical hashes, written last) and `_support/openapi.snapshot.meta.json`, which makes the snapshot a `diff` baseline. New `registry validate [path] [--spec] [--require-spec]` and `manifest validate`. Case ID encoding / parsing and the rule vocabulary v1 with its allowed combinations follow the design.
- **`diff`: semantic diff of two OpenAPI specs** (step 1 of docs/OPENAPI_CHANGE_TRIGGER.md). Writes `changes.json` (schema in `schemas/changes.schema.json`) and, with `--format markdown`, `changes.md`: operations added / removed / moved (rename detection with the documented thresholds; uncertain links marked `review`), `operationId` and path parameter renames, parameter, request and response changes, schema constraint changes per facet and direction, example / default changes, servers. Deterministic `operationUid` per operation. Formatting, descriptions, `$ref` layout, equivalent `allOf` and 3.0 ↔ 3.1 nullable give no changes. Compatibility verdicts come from oasdiff `1.34.1` (`OASDIFF_BIN` or `PATH`, not bundled; version pinned). Baseline: `--base`, else the Git merge base; otherwise `BLOCKED: BASE_SPEC_MISSING`. URLs need `--allow-network`; private and metadata hosts are denied unless allowed. Exit codes 0 / 1 (`--fail-on breaking | blocked | unknown`, repeatable, default `blocked`) / 2 (configuration).
- **A failed create check no longer leaves data:** the resource helper's `create()` removes the record before failing when a check after the request fails (e.g. the API answers an undocumented `201` where the spec says `200`). Before, the test failed before cleanup was registered, and the record stayed (found on Toolshop favorites).
- **deps file `fill`: values from existing data:** a chain can take a create body field from an existing record at run time, e.g. `"fill": { "product_id": { "from": "getProducts", "pointer": "/data/0/id" } }`, instead of creating the parent. The source must be a `GET` with no unknown required parameters, and the pointer a JSON pointer; otherwise the chain is blocked with the reason. Filled values are never suffixed. `newCreatePayload(api)` becomes async for such chains (Python: an instance method).
- **Stale resource helpers are removed:** `generate` deletes generated `_support/*.resource.ts` (`*_resource.py`) of chains it no longer plans (e.g. a delete was unlinked) and lists them as `REMOVED`. Hand-written helpers stay.
- **Test data left on the target is reported:** the generated cleanup (`remove()` in the resource helpers, TypeScript and Python) still never fails a test, but a delete that does not succeed (anything but 2xx or 404) is now recorded. `generate --run` prints `WARNING: cleanup could not remove N record(s)` with a summary per operation and status, and the report gets a "Test data left on the target" table with every id. A standalone run prints a warning per record.
- **Unique values where the spec documents a conflict:** when a create or update operation documents `409`, the plain string fields of its example payload (no `enum` / `const` / `format`; a `pattern` must still match) get a random suffix on every call, shortened to `maxLength`. Resource helpers expose `newCreatePayload()` / `newUpdatePayload()` (Python: `new_create_payload()` / `new_update_payload()`); the examples stay exported unchanged. Fixes repeated runs failing with 409 on shared environments (e.g. a `slug` left by an earlier run).
- **More deterministic checks:** a create → read scenario (the created resource is readable by the returned id) under the create operation, TypeScript and Python; GET cases for each value a query parameter's `enum` allows; rejection cases for `exclusiveMinimum` / `exclusiveMaximum`, `minItems` and query `minLength`. `generate` writes `coverage-gaps.json` next to the report (cases per suite per operation and why a side is missing).
- **Three suite files per operation (breaking layout change):** `<resource>/<method>[-by-id]/` now holds up to `functional.spec.ts`, `contract.spec.ts` and `scenarios.spec.ts` (Python: `test_functional.py`, `test_contract.py`, `test_scenarios.py`) instead of `positive` / `negative`. Functional checks status and result; contract checks conformance to OpenAPI (schema of whatever status came back, documented rejections of invalid input); scenarios hold multi-request flows in the folder of the action under test (update → read, delete → read 404). Polarity is a tag (`@positive` / `@negative`, pytest markers), not a file. No empty files; a suite without cases is reported with its reason. `generate` removes the generated files of the old layout (header-checked, hand-written files stay) and lists them as `REMOVED`; `--draft-pr` commits the removals.
- **API objects in generated TypeScript suites (breaking for hand edits of generated specs):** every request goes through `_support/api/<Name>Api.ts` (`api.brands.getBrands()`), one class per first path segment. `generated/<Name>ApiBase.ts` is rewritten on every generate; `<Name>Api.ts` extends it, is created once and never overwritten, for hand-written reusable requests. Resource helpers take the `api` fixture instead of `request`.
- **`publicApi` fixture:** operations without `security` and 401 checks run without any credentials, so they no longer log in (a broken login used to fail every test, public ones included).
- **Test account question before a run (API_LOGIN):** `generate` and `audit` ask whether a test account exists. Yes: credentials from `.env`, checked with one login up front. No: new accounts through `API_REGISTER` / `API_REGISTER_BODY` on every run, stated explicitly (they stay on the server): the generated suite registers one per Playwright worker (`testAccount` worker fixture), the agent one more only for `--probe/--schemathesis`. Generated credentials stay in memory. Preset with `API_TEST_ACCOUNT=existing|new` (read by the suite too) or `--test-account`. TypeScript only for now.
- Demo API: `POST /auth/register` (not in the spec) to exercise the new-account mode.

- Positive tests are no longer built on example path ids (an example like `"1"` is an illustration, not a real record): BLOCKED until a dependency or test data exists. Found on the Toolshop API, where example ids returned 404.
- Logout/revoke operations are kept out of the generated suite: they ended the login session shared by the other tests.

## 0.1.3 - 2026-11-08

Includes 0.1.2, which was tagged but not published to npm.

- **Optional AI (`--ai` on `generate` and `run`) through console tools, no API keys:** `claude -p` (Claude Code), `codex exec`, or any command following a stdin/stdout JSON contract (for orchestrators). Proposes answers for unconfirmed dependencies from a minimal excerpt (names and types only); every answer is schema-validated, checked against the spec and written to `ai-deps.proposed.json` for review; nothing is applied automatically.

## 0.1.2 - 2026-11-08

- **Login-based auth for short-lived tokens:** `API_LOGIN`, `API_LOGIN_BODY` (with `${VAR}` from `.env`), `API_TOKEN_POINTER`. The agent logs in before network checks; generated TypeScript (fixtures) and Python (conftest) suites log in and refresh the token themselves. `init` asks for it.
- Generated 401 tests (TypeScript) now really send no credentials: `newContext()` inside a test inherited the project's auth header.
- Secret redaction covers every TOKEN / PASSWORD / SECRET / API_KEY variable.
- Demo API: `POST /auth/login` (5-minute tokens) and a secured `GET /me`.
- CI can be started manually (`workflow_dispatch`).
- Docs and CLI hints use `npx @testomut/api-test-agent`: the bare `npx api-test-agent` resolves to an unrelated npm package when the tool is not installed locally.

## 0.1.1 - 2026-11-08

Fixes found by auditing public APIs (Swagger Petstore, FakeRESTApi, Practice Software Testing / Toolshop):

- Contract checks match documented media types that carry parameters (`application/json; v=1.0`). Before, such APIs got false content-type mismatches.
- OpenAPI 3.2 specs are accepted and processed with the 3.1 rules; the report says that 3.2-only features are not checked.
- A linter failure is reported as a warning instead of stopping the run.
- Schemathesis findings show the check name, not just the code (`ST201 Schema-violating request accepted`).
- Reports and logs show the spec's real OpenAPI version.
- `init` adds `node_modules/` to `.gitignore`.
- `generate --lang python` refuses a tests folder whose package name would shadow a Python module (e.g. `tests/py`).

## 0.1.0 - 2026-11-08

First release: `init`, `run`, `audit`, `generate` (TypeScript or Python), `adapt`.
