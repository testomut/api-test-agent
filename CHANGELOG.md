# Changelog

## Unreleased

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
