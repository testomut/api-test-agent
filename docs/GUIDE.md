# api-test-agent guide

Everything a user needs after `npm install`: setup, configuration, commands, every check the tool runs, and what it changes in your project (and what it never touches).

- [1. Quick start](#1-quick-start)
- [2. Configuration](#2-configuration)
- [3. What `init` changes in your project](#3-what-init-changes-in-your-project)
- [4. Commands](#4-commands)
- [5. What `run` does, step by step](#5-what-run-does-step-by-step)
- [6. Checks catalogue](#6-checks-catalogue)
- [7. Test layout](#7-test-layout)
- [8. Statuses](#8-statuses)
- [9. Safety](#9-safety)
- [10. FAQ](#10-faq)

## 1. Quick start

```sh
npm i -D @testomut/api-test-agent @playwright/test ajv ajv-formats
npx @testomut/api-test-agent init        # 6 questions (incl. test language), shows the plan of changes, applies only after you confirm
# paste your TEST token into .env (API_TOKEN=...) if the API needs one
npm run api-tests              # first analysis, read-only
# read reports/api-agent/report.md
npm run api-tests:generate     # generate missing tests and run them once
npx playwright test
```

**Always use the scoped name with npx:** `npx @testomut/api-test-agent …`. Inside a project where the package is installed, the npm scripts (`npm run api-tests`) and the scoped `npx` use the local copy. The bare `npx api-test-agent` downloads an **unrelated package** with that name when the tool is not installed locally.

Optional: `pip install schemathesis` adds generative contract checks. Without it everything else works and the report says it was skipped.

**Python tests instead of TypeScript:** answer `python` to the language question (or set `API_TESTS_LANG=python`). Generated tests then use pytest + requests and need `pip install pytest requests jsonschema`; Playwright and `ajv` are not needed. Run them with `python -m pytest tests/api`.

## 2. Configuration

All settings are environment variables. `init` writes them to `.env` (ignored by git) and documents them in `.env.example` (safe to commit). Variables set in the real environment, such as CI secrets, override `.env`.

| Variable | Required | Meaning |
|---|---|---|
| `API_BASE_URL` | yes | Base URL of the **test** environment. |
| `API_TOKEN` | if the API needs auth | Bearer token. Secret: `.env` or CI secrets only. Also used for OAuth2 / OpenID Connect schemes. |
| `API_SPEC_URL` | no | OpenAPI / Swagger spec: URL or file path. If empty, `run` looks for `openapi.yaml` / `swagger.json` in the project and at well-known URLs of the API (`/openapi.json`, `/v3/api-docs`, …). |
| `POSTMAN_COLLECTION` | no | Postman collection: path to an exported `.json` file, **or** a collection id/uid from the Postman cloud. Collections committed to the repository are found automatically. |
| `POSTMAN_API_KEY` | only for a cloud id | Postman API key (postman.com → Settings → API keys). Secret. |
| `API_TESTS_DIR` | no | Folder with API tests. Default `tests/api`. Other folders (UI, unit, e2e) are never modified. |
| `API_TESTS_LANG` | no | Language of generated tests: `typescript` (Playwright Test, default) or `python` (pytest + requests). `generate --lang` overrides it. |
| `API_TESTS_PYTHON` | no | Python interpreter that runs generated pytest suites with `generate --run`. Default: `./.venv`, then `python` on PATH. |

Other credentials: `API_USER` + `API_PASSWORD` (HTTP basic, or the login body below), `API_KEY` (apiKey in a header or query).

### Short-lived tokens: log in instead of `API_TOKEN`

Many APIs issue tokens that expire in minutes (a JWT with `expires_in: 300` is common), so a token pasted into `.env` goes stale. Configure the login request instead:

```
API_LOGIN=POST /users/login
API_LOGIN_BODY={"email":"${API_USER}","password":"${API_PASSWORD}"}
API_TOKEN_POINTER=/access_token
API_USER=qa-account@example.com
API_PASSWORD=...
```

- `${VAR}` in `API_LOGIN_BODY` is filled from `.env` / the environment, so you can name the variables as you like (`${SHOP_USER_EMAIL}`).
- The agent logs in before `run`, `audit --probe/--schemathesis`; the report shows the result as the `API_LOGIN` check.
- Generated suites log in on their own and refresh the token 30 s before it expires: TypeScript through `_support/fixtures.ts` (a worker-scoped token source), Python through the `token_source` session fixture in `conftest.py`. No change to `playwright.config` is needed.
- Credentials are never written to reports, logs or generated files; any variable whose name contains TOKEN, PASSWORD, SECRET or API_KEY is redacted from output.
- `init` asks for it (`l = login request`), or non-interactively: `init --login "POST /users/login" --login-body '{...}' --token-pointer /access_token`.

#### No test account? Register one on every run

Before `generate` and `audit` log in, they ask: **Do you have a test account?**

- **Yes** (`existing`): the credentials above are read from `.env`.
- **Auto** (`auto`, only with `API_TEST_ACCOUNT=auto` or `--test-account auto`): the account from `.env` while it works. Only when it is missing or its login is refused (401 / 403 / 422, e.g. the test environment reset its data) is a new one registered: by the agent before `--run` (the generated tests then use that one), or by a Playwright worker that hits the refusal (one per such worker). A working account never causes a registration, and `.env` is never changed. Needs `--allow-write` for the agent's registration.
- **No** (`new`): **new accounts are registered on every run** and left on the server (nothing deletes them): the generated suite registers **one per Playwright worker** (the `testAccount` worker fixture in `_support/fixtures.ts`), so parallel workers never share user data; the agent registers one more only for its own `--probe/--schemathesis`. Emails (`api-test-<unique>@example.com`) and passwords are generated and kept in memory only. Needs `--allow-write`. Playwright starts a fresh worker after a failed test, and that worker registers its own account too.

```
API_REGISTER=POST /users/register
API_REGISTER_BODY={"first_name":"Api","last_name":"Test","email":"${API_USER}","password":"${API_PASSWORD}"}
```

`API_REGISTER_BODY` must use the same `${VAR}`s as `API_LOGIN_BODY`; `${UNIQUE}` is a per-run suffix for other unique fields. To skip the question (CI): `API_TEST_ACCOUNT=existing|new|auto` or `--test-account existing|new|auto`. Python suites support `existing` only (for now). Without a terminal and without the setting, an account in `.env` means `existing`; otherwise the run stops with an explanation.

You need at least one of: a spec, a Postman collection, or existing tests. With none of them there is nothing to analyse.

## 3. What `init` changes in your project

You do not copy or paste anything by hand. Before changing anything, `init` prints the full plan (every file it will create or change, and why) and asks for confirmation; the default answer is no. `npx @testomut/api-test-agent init --dry-run` shows the plan without changing anything. It is safe to run again: it only adds what is missing and never overwrites your values.

| File | What happens |
|---|---|
| `.env` | Created with your answers. If it exists, only missing variables are appended; existing values are kept. |
| `.env.example` | Created with every variable and a comment. Commit it. |
| `.gitignore` | Missing lines are appended: `.env`, `reports/`, `test-results/`, `playwright-report/`. Nothing is removed. |
| `playwright.config.ts` | Created **only if the project has no Playwright config**. It reads `.env`, sets `baseURL` from `API_BASE_URL` and the auth header from `API_TOKEN`. An existing config is never changed; `init` tells you what to check in it. |
| `API_TESTS_DIR` | Created if missing. |
| `.claude/skills/api-test-writer/` | **Only if you agree to it** (separate question, default no; `--with-skill` in non-interactive mode). See below. |
| `package.json` | Scripts added if missing: `api-tests`, `api-tests:generate`, `test:api`. Missing dependencies are reported, not installed. |

Nothing is installed or changed when you run `npm install`: the package has no install scripts.

### About the Claude Code skill

The skill is a Markdown file with test-writing rules (layout, positive/negative cases, cleanup, never invent expected results). Claude Code loads skills from `.claude/skills/` automatically, so installing it **changes how the AI agent behaves in this project**. It contains no code, runs nothing and grants no permissions or tool access, but treat it like any instruction given to an agent:

- read it before installing: `node_modules/@testomut/api-test-agent/skills/api-test-writer/SKILL.md` (`init` prints the exact path);
- review changes to `.claude/` in pull requests like code: anyone who can edit those files can change what the agent is told;
- if you edited your copy, `init` keeps it; `--force` replaces it with the packaged version;
- to remove it, delete `.claude/skills/api-test-writer/`.

Non-interactive (CI, scripts): `npx @testomut/api-test-agent init --yes --base-url https://api.test.example.com [--spec <url|file>] [--postman <file|id>] [--tests-dir tests/api] [--token] [--with-skill]`. `--yes` applies the plan without asking; the skill is installed only with `--with-skill`.

## 4. Commands

| Command | Changes files? | Sends requests? | Purpose |
|---|---|---|---|
| `init` | yes, after showing the plan and your confirmation (see §3) | no | One-time project setup. `--dry-run` shows the plan only. |
| `run` | only `reports/api-agent/` | read-only GETs (`--no-probe` to disable) | Analysis: environment, spec, existing tests, Postman, dependency and coverage maps, proposals. |
| `audit [spec]` | only the report folder | read-only with `--probe` / `--schemathesis` | Spec and contract checks only. |
| `generate [spec]` | only `API_TESTS_DIR` | with `--run`: creates and deletes test data (needs `--allow-write`) | Generates `functional` / `contract` / `scenarios` tests for each operation. |
| `generate --draft-pr` | new git branch | pushes the branch | Opens a GitHub Draft PR for review. Never touches the default branch. |
| `adapt` | yes, after showing the plan and your confirmation | no | Moves existing API tests into the layout and converts uncovered Postman requests (see §5a). `--dry-run`, `--yes`, `--only moves|postman`. |
| `diff --head <spec>` | only `--out` (default `reports/api-agent/diff/`) | no (a URL needs `--allow-network`) | Semantic diff of two specs: `changes.json` (and `changes.md` with `--format markdown`), a compatibility verdict per change from [oasdiff](https://github.com/oasdiff/oasdiff). See §4a. |
| `registry validate [path]` | no | no (a URL `--spec` needs `--allow-network`) | Checks `_support/cases.json`: syntax always, active entries against `--spec` too. Exit 1 on an invalid entry. See §4b. |
| `manifest validate` | no | no | Compares generated files with the hashes in `_support/generation-manifest.json`. Exit 1 on a modified or missing generated file. |

`[spec]` defaults to `API_SPEC_URL`, `--base-url` to `API_BASE_URL`, `--tests-dir` to `API_TESTS_DIR`.

## 4a. `diff`: what changed between two specs

The first step of the [change-triggered generation design](OPENAPI_CHANGE_TRIGGER.md). Static: it never calls the API and writes only to `--out`.

```sh
npx api-test-agent diff --base old/openapi.yaml --head openapi.yaml --format markdown
npx api-test-agent diff --head openapi.yaml            # base: the same file at the Git merge base (GITHUB_BASE_REF, else origin's default branch)
npx api-test-agent diff --head https://host/openapi.json --base snapshot.json --allow-network --allow-host host
```

- **Engine:** compatibility verdicts (`breaking: yes | no | unknown`) come from [oasdiff](https://github.com/oasdiff/oasdiff) `1.34.1`, found through `OASDIFF_BIN` or `PATH`; it is not bundled. Another version stops with exit code 2 unless `--allow-engine-version-mismatch`. A change the engine says nothing about stays `unknown`.
- **Identity:** each operation gets `operationUid = op_ + base32(sha256(METHOD + " " + normalizedPath))[0:12]`; path parameter names are not part of it (`/brands/{id}` and `/brands/{brandId}` are the same operation, reported as `parameter-renamed`). Moves and renames are detected with the documented rules and thresholds; a link below 0.90, or without a clear lead, is marked `review`.
- **No noise:** formatting, key order, descriptions, `$ref` layout, inline ↔ component, equivalent `allOf` and 3.0 `nullable` ↔ 3.1 `type: [x, null]` give no changes. Example / default changes are listed separately (non-breaking, but the generator uses them as payloads).
- **Baseline:** `--base`, else the Git merge base, else the suite's snapshot (`_support/openapi.snapshot.ts` / `openapi_snapshot.json`) when `openapi.snapshot.meta.json` is next to it (written by `generate`). Without a baseline the result is `BLOCKED: BASE_SPEC_MISSING`.
- **Network:** off by default. `--allow-network` is needed for any URL; localhost, private and link-local addresses (including cloud metadata) are denied unless named in `--allow-host`.
- **Exit codes:** 0 the policy passed, 1 a `--fail-on` policy triggered, 2 configuration or runtime error. `--fail-on breaking | blocked | unknown` can be repeated and combined; default `blocked`; `never` stands alone.
- **Output:** `changes.json` (schema: [`schemas/changes.schema.json`](../schemas/changes.schema.json)), plus `changes.md` with `--format markdown`.

Not in this step: which tests a change affects (`plan`), updating tests.

## 4b. Stable case IDs

Every generated test carries a case ID that survives regeneration and spec edits that do not change what it checks:

```text
ata:<subjectUid>:<suiteType>:<polarity>:<location>:<rule>
ata:op_4PIO72ZI3SIY:contract:negative:request.query#/limit:maximum
ata:scn_…:scenario:positive:lifecycle:crud
```

- **Where:** Playwright `{ tag: '@negative', annotation: { type: 'caseId', description: '…' } }` (visible in the HTML / JSON report); pytest `@pytest.mark.api_case_id("…")` (registered in `conftest.py`), on `pytest.param` for parametrized cases.
- **Subjects:** `operationUid = op_ + base32(sha256(METHOD + " " + normalizedPath))[0:12]` (path parameter names are not part of it); CRUD scenarios get `scenarioUid = scn_ + base32(sha256("type=crud;steps=<phase>:<uid>>…"))[0:12]`.
- **Rules:** a versioned vocabulary (v1): `documented-success`, `not-found`, `unauthorized`, `schema`, `documented`, the schema constraints (`maxLength`, `required`, …), `crud`. The constraint *value* is never part of the ID, so `maxLength 50 → 100` keeps the case.
- **`_support/cases.json`** is the registry: operations, cases and scenario definitions (steps with phases, roles). It is never rebuilt from the spec: existing UIDs are kept (an `x-api-test-agent-id` or the same method + normalized path wins over the hash), removed operations become tombstones (`status: "retired"`), history is never deleted. Canonical JSON: sorted keys, 2 spaces, LF.
- **`_support/generation-manifest.json`** lists every generated file with its canonical hash (SHA-256 of the UTF-8 content with LF line endings), suite type, case IDs and operations. API object subclasses (`_support/api/<Name>Api.ts`) are `hand-written`. Written last.
- **`_support/openapi.snapshot.meta.json`**: `generatorVersion`, `specHash`, `source`, `capturedRevision` — makes the snapshot a `diff` baseline.

Not yet: three-way `registry merge`, `--id-aliases` / `--apply-registry`, `plan`, `--apply-generated`.

## 5. What `run` does, step by step

1. **Environment**: `.env` present and ignored by git; `API_BASE_URL` answers; target type (local / test / production / unknown); `API_TOKEN` accepted by a secured endpoint.
2. **Spec**: found or configured, valid OpenAPI 3.x, Redocly lint.
3. **Live contract** (read-only): one GET per safe operation with spec-provided values, and a bounded Schemathesis run if installed.
4. **Test inventory**: finds every test file and classifies it: Playwright API, Playwright UI, Cypress, pytest, Jest/Vitest, Postman. UI and other tests are listed and never modified.
5. **Existing API tests** (static analysis, no AI): HTTP calls per test, the asserted call and status (positive or negative), preconditions, and ids passed from one response into a later URL.
   - **Playwright (TS/JS):** `beforeAll` / `beforeEach`, fixtures (`test.extend`), helper functions.
   - **pytest (requests / httpx / sessions):** fixtures including `yield` teardown and `autouse`, `conftest.py`, `setup_method` / `teardown_method` in test classes, API client wrappers, module-level state shared through `global`. Uses Python's own `ast` module through a small stdlib-only script, so it needs Python 3.9+ (`API_TESTS_PYTHON` or `./.venv` or `python` on PATH); without Python the files are listed but not analysed.
6. **Postman**: requests (folders flattened), `pm.test` assertions and statuses, saved example responses, and variable chains (`pm.collectionVariables.set("orderId")` → `{{orderId}}`).
7. **Dependency map**: edges between operations from three sources, each labelled: OpenAPI `links` (confirmed by the spec), existing tests and Postman (confirmed in practice), path similarity only (candidate, needs your confirmation). Rendered as a Mermaid diagram and a table with evidence (`file:line`, request names).
8. **Coverage map**: per operation: in spec or not, positive tests, negative tests, use as a precondition, Postman requests, generated files, live contract result.
9. **Proposals**: (A) move existing tests into the layout (A2: tests that cannot be moved yet, with the reason), (B) convert Postman requests that no test covers, (C) generate missing tests, (D) what cannot be generated yet and the one fix each needs. A and B are applied by `adapt` (§5a).
10. **Report**: `reports/api-agent/report.md` and `report.json`, plus a one-line summary in the terminal. Exit code 1 only when an environment check fails.

## 5a. What `adapt` does

`adapt` applies proposals A and B from the `run` report.

**Safety first**
- Runs only in a git repository with a clean working tree, so its changes can be reviewed with `git diff` and reverted on their own (`--allow-dirty` to override). `--dry-run` works anywhere.
- Prints the plan (every file created, rewritten or deleted, and every test it will not touch, with the reason) and asks before applying; the default answer is no.
- After writing, every changed file must collect (`playwright test --list` or `pytest --collect-only`). If not, **everything is rolled back**. If the runner is not installed, the result is applied and reported as not verified.
- Prints the exact commands to review and to revert.

**Moving tests**
- Test code is never rewritten. A moved test keeps everything around it in its file: imports, `beforeAll` / fixtures / `setup_method`, shared variables. Only the other tests are left out of the copy, and relative imports (TS/JS) are re-pointed.
- Destination: the folder of the operation the test asserts, positive or negative, with the source file name kept: `tests/items.test.ts` → `tests/api/items/post/negative.items.spec.ts`; `tests/test_items.py` → `tests/api/items/post/test_negative_items.py`. Python folders get `__init__.py`.
- The source file is rewritten without the moved tests, or deleted when all of them moved.
- **Not moved:** tests that share state with another test (one sets a variable, another reads it), tests whose destination file already exists, tests with no API call to classify. The plan lists them with the reason.
- Moved tests keep their original problems (hard-coded tokens, sleeps...): `run` keeps reporting them so they can be fixed deliberately.

**Converting Postman requests**
- Only requests that no existing test covers, and only when nothing has to be guessed: no variables set by other requests, no `{{variables}}` in body, headers or query, JSON body.
- Assertions: the statuses from `pm.test`; if the request had none and the operation is in the spec, the documented success status (marked as such in the test). Other `pm.test` lines are copied as comments for review.
- Output in the configured language: `<resource>/<method>/positive.postman.spec.ts` or `test_positive_postman.py`.

## 5b. Optional AI (`--ai`), through console tools

Everything above is deterministic. `--ai` adds an AI step in **one** place where rules cannot decide: **unconfirmed dependencies** (`POST /x` + `/x/{param}` with no OpenAPI `links` and no deps file, normally BLOCKED with a question).

The AI runs through a **console tool you are already logged in to**: no API keys, usage counts against your subscription.

| `API_AI` / `--ai-runner` | Runs | Notes |
|---|---|---|
| `claude` (default) | `claude -p --output-format json --json-schema … --tools "" --no-session-persistence` | Claude Code subscription. No tools: the model only answers |
| `codex` | `codex exec --output-schema … --sandbox read-only --ephemeral` | Codex CLI subscription |
| `command` | `API_AI_COMMAND` | Your own executable, e.g. an orchestrator (contract below) |

```sh
npx @testomut/api-test-agent generate --ai            # or: run --ai, --ai-runner codex
# review reports/api-agent/generate/ai-deps.proposed.json, then:
npx @testomut/api-test-agent generate --deps reports/api-agent/generate/ai-deps.proposed.json --allow-write --run
```

**Contract for `command` (orchestrators):** the request is written to stdin as JSON `{"system": "...", "prompt": "...", "schema": {JSON Schema}}`; the tool prints the answer object (matching the schema) as JSON on stdout and exits 0. The tool runs in an empty temporary folder.

- **Opt-in only.** Without `--ai` no tool is called.
- **Minimal context.** For each candidate: operation keys and ids, the create response's property names and types, the path parameter's type. Never example values, request data, test results or `.env` contents.
- **Validated twice.** The answer must match the JSON Schema (checked here, not only by the tool), then the spec: the identifier pointer must exist in the create response and its type/format must match the path parameter; low confidence is rejected.
- **Proposals, never applied.** Accepted answers go to `ai-deps.proposed.json` (deps-file format); every answer with its reason to `ai-proposals.json`. Tests use them only after you pass the file with `--deps`, and running the tests then confirms the link against the real API.
- **Budget:** `--ai-max-calls` (default 10). The run ends with answers, failures, time and, for `claude`, the cost Claude Code reports (only billed per call when you use an API key instead of a subscription).
- **Tool missing or not logged in:** the AI step is skipped with a message; the rest of the run is unaffected.

## 6. Checks catalogue

**Environment**
| Check | Fails when |
|---|---|
| `.env` ignored by git | `.env` exists and `.gitignore` does not list it |
| Base URL | not set, or does not answer within 5 s |
| Target type | host looks like production: writes are refused |
| Token | a secured endpoint answers 401/403 with it |

**Spec**
| Check | Source |
|---|---|
| Valid OpenAPI 3.0 / 3.1 | swagger-parser |
| Lint (recommended rules, or your `redocly.yaml`) | Redocly |
| Required parameter without example/default/enum | catalogue |
| 2xx response without schema | catalogue |
| No 2xx response documented | catalogue |
| No `operationId` | catalogue |
| Request body required but no schema | catalogue |

**Existing tests**
| Code | Meaning |
|---|---|
| `hardcoded-secret` | a token or key in the source |
| `hardcoded-url` | an absolute URL instead of `baseURL` |
| `wait-for-timeout` | fixed sleep (`waitForTimeout`, `time.sleep`) |
| `no-cleanup` | the file creates data and never deletes it |
| `status-only` | a positive test checks only the status code |
| `no-assertion` | a test calls the API and asserts nothing |
| `order-dependent` | a test uses a value set by another test |
| layout | file is not in `<resource>/<method>/` with a suite prefix (`functional|contract|scenarios`, or the older `positive|negative`) (proposal A) |

**Postman**
| Check | Meaning |
|---|---|
| no assertions | request without `pm.test` |
| hard-coded auth | `Authorization` header with a literal value |
| out-of-order chain | a request uses a variable that only a later request sets |
| undocumented endpoint | request path not in the spec |

**Live API (contract)**
| Check | Meaning |
|---|---|
| status documented | the response status is listed for the operation |
| content type | matches the documented media type |
| schema | body validates against the documented schema |
| Schemathesis | generative positive/negative checks, `--checks all` |

**Generated tests**
| File | Positive (`@positive`) | Negative (`@negative`) |
|---|---|---|
| `functional.spec.ts` | documented success status with spec-provided data; create returns an id, read returns the created resource | unknown id → 404, no credentials → 401 (status only) |
| `contract.spec.ts` | the returned status is documented and the body matches the schema: success, missing-id and anonymous responses | missing required field, wrong type, min/max and length bounds, enum, unknown field, minProperties, invalid query params → documented 400/422 |
| `scenarios.spec.ts` | create → read by the returned id; update → read returns the new values; delete → read gives 404. Lives in the folder of the operation under test (create, update or delete), never of a setup step | |

A negative case is generated only when the spec documents the rejection (400 / 422 / 4XX, 404, 401). A file is written only when it has at least one case; otherwise the report says why (`BLOCKED` per suite).

## 7. Test layout

Same cases and rules in both languages; only the file conventions differ.

**TypeScript (Playwright Test)**

```
tests/api/
  orders/
    get/            functional.spec.ts  contract.spec.ts
    get-by-id/      functional.spec.ts  contract.spec.ts
    patch-by-id/    functional.spec.ts  contract.spec.ts  scenarios.spec.ts
    post/           functional.spec.ts  contract.spec.ts
  _support/
    api/
      generated/    ApiBase.ts, <Name>ApiBase.ts (one method per operation), apis.ts: rewritten on every generate
      <Name>Api.ts  extends the generated base; created once, never overwritten: your reusable requests
    fixtures.ts     api, publicApi, request, testAccount (one per worker)
                    contract checks, spec snapshot, <resource>.resource.ts (create/remove helpers)
```

Every request goes through an **API object** (the API counterpart of a page object), grouped by the first path segment: `/orders`, `/orders/{id}`, `/orders/search` → `OrdersApi`. Methods return the raw `APIResponse`; assertions stay in the tests.

```ts
test('...', async ({ api, publicApi }) => {
  const res = await api.orders.getOrder(id, { params: { expand: 'items' } });
  const anon = await publicApi.orders.getOrders(); // no credentials at all
});
```

- `api`: with the test account's token (logs in lazily, refreshes before expiry). `publicApi`: no credentials; used for operations without `security` and for 401 checks, so they never depend on the login.
- Your own requests and flows go into `_support/api/OrdersApi.ts` (it extends `OrdersApiBase`); other API objects are available there as `new ProductsApi(this.request)`. Regeneration rewrites only `generated/`, so new endpoints arrive and your code stays.

**Python (pytest + requests)**

```
tests/api/
  conftest.py       fixtures: api, anonymous_api, contract, <resource>, created_<resource>
  orders/
    get/            test_functional.py  test_contract.py
    get_by_id/      test_functional.py  test_contract.py
    patch_by_id/    test_functional.py  test_contract.py  test_scenarios.py
    post/           test_functional.py  test_contract.py
  _support/         contract.py (jsonschema), openapi_snapshot.json, <resource>_resource.py
```

Python folders use underscores and contain `__init__.py`, so `test_functional.py` can repeat across folders. Each module has `pytestmark = pytest.mark.<suite>` and each test `@pytest.mark.positive` or `@pytest.mark.negative` (registered in `conftest.py`). Invalid inputs use `pytest.mark.parametrize`; preconditions and cleanup are fixtures (`created_orders` creates before the test and deletes after it).

- Folder = static path segments (`/orders` → `orders`, `/admin/reset` → `admin-reset`), then the method, with `-by-id` when the path ends with a parameter.
- Generated files are overwritten when the spec changes. Hand-written cases go next to them in `*.manual.spec.ts`; converted Postman requests in `*.postman.spec.ts`.

## 8. Statuses

| Status | Meaning |
|---|---|
| `PASS` | the executed checks passed (not a claim of full coverage) |
| `CONTRACT_MISMATCH` | the API differs from the spec: decide whether to fix the API or the spec |
| `TEST_FAILURE` | the test or the infrastructure failed |
| `BLOCKED` | missing data, credentials or requirements: the reason says exactly what |
| `NOT_RUN` | skipped by mode, safety settings or budget |

## 9. Safety

- `run` and `audit` send only GET requests, with a budget (100 requests), rate limit (5/s) and timeouts.
- Writes need `--allow-write`. Hosts that look like production are refused; hosts that cannot be classified need `--confirm-test-env`.
- Write operations without a confirmed cleanup are never generated.
- Tokens are read from the environment and redacted from every log and report.
- Assertions are never changed to make a test pass.

## 10. FAQ

**Do I need to copy the skill or edit `.gitignore` myself?** No. `init` updates `.gitignore` and, if you agree, installs the skill. It shows the plan first and can be run again safely.

**My tests are not in `tests/api`.** Set `API_TESTS_DIR`, or follow proposal A in the report. `run` lists API tests it found outside that folder.

**The project also has UI tests.** They are detected (`page.goto`, locators), listed in the inventory and never modified.

**Only Postman, no spec?** `run` still builds the dependency and coverage map from Postman. Contract checks and test generation need a spec.

**Postman cloud or file?** Both. A path ending in `.json` is read from disk; anything else is treated as a cloud collection id and needs `POSTMAN_API_KEY`.

**Does it use AI?** Only with `--ai`, through a console tool you are logged in to (Claude Code, Codex, or your own orchestrator), and only to propose answers for unconfirmed dependencies, which you review (§5b). No API keys. Everything else (spec analysis, cases, payloads, test analysis, generation) is rule-based and reproducible.

**Which languages can tests be generated in?** TypeScript (Playwright Test) and Python (pytest + requests), chosen in `init` or with `API_TESTS_LANG` / `--lang`. The analysis, cases and safety rules are shared; only the output templates differ, so more languages can be added.

**Which test frameworks are analysed?** Playwright (TS/JS), pytest (requests / httpx) and Postman v2.x in depth. Cypress and Jest/Vitest API tests are found and listed; deeper analysis is planned.
