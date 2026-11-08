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
npx api-test-agent init        # 6 questions (incl. test language), shows the plan of changes, applies only after you confirm
# paste your TEST token into .env (API_TOKEN=...) if the API needs one
npm run api-tests              # first analysis, read-only
# read reports/api-agent/report.md
npm run api-tests:generate     # generate missing tests and run them once
npx playwright test
```

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

Other credentials: `API_USER` + `API_PASSWORD` (HTTP basic), `API_KEY` (apiKey in a header or query).

You need at least one of: a spec, a Postman collection, or existing tests. With none of them there is nothing to analyse.

## 3. What `init` changes in your project

You do not copy or paste anything by hand. Before changing anything, `init` prints the full plan (every file it will create or change, and why) and asks for confirmation; the default answer is no. `npx api-test-agent init --dry-run` shows the plan without changing anything. It is safe to run again: it only adds what is missing and never overwrites your values.

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

Non-interactive (CI, scripts): `npx api-test-agent init --yes --base-url https://api.test.example.com [--spec <url|file>] [--postman <file|id>] [--tests-dir tests/api] [--token] [--with-skill]`. `--yes` applies the plan without asking; the skill is installed only with `--with-skill`.

## 4. Commands

| Command | Changes files? | Sends requests? | Purpose |
|---|---|---|---|
| `init` | yes, after showing the plan and your confirmation (see §3) | no | One-time project setup. `--dry-run` shows the plan only. |
| `run` | only `reports/api-agent/` | read-only GETs (`--no-probe` to disable) | Analysis: environment, spec, existing tests, Postman, dependency and coverage maps, proposals. |
| `audit [spec]` | only the report folder | read-only with `--probe` / `--schemathesis` | Spec and contract checks only. |
| `generate [spec]` | only `API_TESTS_DIR` | with `--run`: creates and deletes test data (needs `--allow-write`) | Generates `positive` / `negative` tests for each operation. |
| `generate --draft-pr` | new git branch | pushes the branch | Opens a GitHub Draft PR for review. Never touches the default branch. |
| `adapt` | (next release) | | Applies the "move" and "convert Postman" proposals. |

`[spec]` defaults to `API_SPEC_URL`, `--base-url` to `API_BASE_URL`, `--tests-dir` to `API_TESTS_DIR`.

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
9. **Proposals**: (A) move existing tests into the layout, (B) convert Postman requests that no test covers, (C) generate missing tests, (D) what cannot be generated yet and the one fix each needs.
10. **Report**: `reports/api-agent/report.md` and `report.json`, plus a one-line summary in the terminal. Exit code 1 only when an environment check fails.

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
| layout | file is not in `<resource>/<method>/positive|negative` (proposal A) |

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
| File | Cases |
|---|---|
| `positive.spec.ts` | documented success with spec-provided data; create → read → update → delete with checks of the result |
| `negative.spec.ts` | missing required field, wrong type, min/max and length bounds, enum, unknown field, minProperties, invalid query params, unknown id → 404, no credentials → 401 |

A negative case is generated only when the spec documents the rejection (400 / 422 / 4XX, 404, 401). Otherwise only `positive.spec.ts` is created and the report says why.

## 7. Test layout

Same cases and rules in both languages; only the file conventions differ.

**TypeScript (Playwright Test)**

```
tests/api/
  orders/
    get/            positive.spec.ts  negative.spec.ts
    get-by-id/      positive.spec.ts  negative.spec.ts
    post/           positive.spec.ts  negative.spec.ts
  _support/         contract checks, spec snapshot, <resource>.resource.ts (create/remove helpers)
```

**Python (pytest + requests)**

```
tests/api/
  conftest.py       fixtures: api, anonymous_api, contract, <resource>, created_<resource>
  orders/
    get/            test_positive.py  test_negative.py
    get_by_id/      test_positive.py  test_negative.py
    post/           test_positive.py  test_negative.py
  _support/         contract.py (jsonschema), openapi_snapshot.json, <resource>_resource.py
```

Python folders use underscores and contain `__init__.py`, so `test_positive.py` can repeat across folders. Negative cases use `pytest.mark.parametrize`; preconditions and cleanup are fixtures (`created_orders` creates before the test and deletes after it).

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

**Which languages can tests be generated in?** TypeScript (Playwright Test) and Python (pytest + requests), chosen in `init` or with `API_TESTS_LANG` / `--lang`. The analysis, cases and safety rules are shared; only the output templates differ, so more languages can be added.

**Which test frameworks are analysed?** Playwright (TS/JS), pytest (requests / httpx) and Postman v2.x in depth. Cypress and Jest/Vitest API tests are found and listed; deeper analysis is planned.
