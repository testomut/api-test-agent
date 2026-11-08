# api-test-agent

A CLI that takes an OpenAPI 3.x spec, checks how testable it is, runs bounded contract checks against a **test** environment, and generates **reviewable** Playwright + TypeScript API tests where the spec gives enough information.

It does not promise to "cover everything". It produces the part of an API test suite that can be derived cheaply and deterministically, states exactly where coverage stops, and hands the open questions to a human.

```
OpenAPI spec ──► lint + catalogue ──► safe probe ──► Schemathesis ──► report.json / report.md
                         │
                         └──► dependency graph (links / deps file) ──► Playwright CRUD tests ──► run once ──► Draft PR
```

## Principles

- **Deterministic first, no AI in this version.** Parsing, lint, catalogue, payloads, templates, CI: all rule-based. AI is planned only for ambiguous dependencies, with a token budget.
- **The spec is the requirement.** An observed response that differs from the spec is a `CONTRACT_MISMATCH` for a human to decide on. The tool never treats the implementation as the source of truth.
- **Stop with a precise blocker instead of inventing.** No example for a required parameter, a pattern it cannot satisfy, a dependency that is only implied by path names: each becomes `BLOCKED` with the exact question to answer.
- **Never make a test green by editing it.** Generated tests run once; assertions are not touched.
- **Safe by default.** No network calls unless asked. Read-only unless `--allow-write`. Request budget, rate limit and timeouts. Credentials only from environment variables, redacted from every log and report.
- **Coverage counted separately.** Contract checks, functional scenarios and "not checked" are separate numbers, never one merged percentage.

## Statuses

| Status | Meaning |
|---|---|
| `PASS` | The executed checks passed. Not a claim that the endpoint's business logic is covered. |
| `CONTRACT_MISMATCH` | The response differs from the documented contract (status, content type or schema). |
| `TEST_FAILURE` | The generated test or the infrastructure failed. |
| `BLOCKED` | Missing confirmed preconditions, credentials, data or requirements. The reason says which. |
| `NOT_RUN` | Not executed because of mode, safety settings or budget. |

## Use it in your project

```sh
npm i -D @testomut/api-test-agent @playwright/test ajv ajv-formats
npx api-test-agent init        # 6 questions (incl. TypeScript or Python), then shows the plan and asks before applying
npm run api-tests              # read-only analysis → reports/api-agent/report.md
npm run api-tests:generate     # generate missing positive/negative tests and run them once
npx playwright test
```

`init` first prints every file it will create or change and asks for confirmation (`--dry-run` only shows the plan). It writes `.env` / `.env.example`, appends to `.gitignore`, creates `playwright.config.ts` only if you have none and adds npm scripts. The Claude Code skill is offered separately, with an explanation of what it does, and is installed only if you say yes: files in `.claude/` steer the AI agent, so read it first and review `.claude/` changes like code.

`run` analyses what the project already has: existing Playwright and pytest API tests (calls, preconditions from hooks, fixtures, setup methods and helpers, ids passed between requests), Postman collections (file or cloud), and the spec. It builds a **dependency map** and a **coverage map**, lists issues in existing tests, checks the live API against the spec, and proposes how to move existing tests into the layout, which Postman requests to convert and which tests to generate.

**Test language:** TypeScript (Playwright Test) or Python (pytest + requests), chosen in `init` or with `API_TESTS_LANG` / `generate --lang`. Same layout, cases and safety rules in both.

**Full guide: [docs/GUIDE.md](docs/GUIDE.md)** (configuration, every check, what each command changes). Legacy projects to try it on: [Playwright](examples/legacy-project), [pytest](examples/legacy-pytest-project).

## Quick start (this repository)

```sh
npm install
python -m venv .venv && .venv/Scripts/pip install schemathesis   # macOS/Linux: .venv/bin/pip

npm run demo            # in-memory Inventory Demo API on http://localhost:3100

# Static analysis only (no network)
npx tsx src/cli.ts audit demo-api/openapi.yaml

# Read-only probe + bounded Schemathesis run against the test environment
npx tsx src/cli.ts audit demo-api/openapi.yaml -u http://localhost:3100 --probe --schemathesis

# Generate tests/api/<resource>/<method>/{positive,negative}.spec.ts and run them once
npx tsx src/cli.ts generate demo-api/openapi.yaml -u http://localhost:3100 --allow-write --run

npm run test:api        # the generated suite is plain Playwright and runs without the agent
```

The demo API contains one deliberate defect (`GET /stats` returns `total` as a string) and two operations that are hard to test on purpose (`/admin/reset` needs a token, `/reports/{reportId}` has no response schema and no way to obtain an id). Start it with `DEMO_BREAK=create-price` to simulate a regression and watch the generated test report `CONTRACT_MISMATCH POST /items (schema): /price must be number`.

## What the demo run reports

| Operation | Probe | Schemathesis | Functional |
|---|---|---|---|
| `GET /health`, `GET /items` | PASS | PASS | - |
| `GET /stats` | **CONTRACT_MISMATCH** | **CONTRACT_MISMATCH** (ST108) | **CONTRACT_MISMATCH** |
| `GET /items/{itemId}` | BLOCKED: no value for `itemId` | BLOCKED: only 404s, core logic never reached | PASS (positive + negative) |
| `POST/PATCH/DELETE /items…` | NOT_RUN (read-only probe) | NOT_RUN without `--allow-write` | PASS (positive + negative) |
| `GET /reports/{reportId}` | BLOCKED | BLOCKED | negative only (unknown id → 404) |
| `POST /admin/reset` | NOT_RUN | NOT_RUN | BLOCKED: destructive, no confirmed cleanup |

Note the `GET /items/{itemId}` row: Schemathesis exits green for it, but every request returned 404, so the tool reports `BLOCKED` rather than a misleading `PASS`.

## How functional tests are generated

Tests are laid out per resource and operation, with positive and negative cases in separate files:

```
tests/api/
  items/
    get/            positive.spec.ts  negative.spec.ts   (GET /items: limit below/above bounds, wrong type)
    post/           positive.spec.ts  negative.spec.ts   (10 invalid bodies, one broken rule each)
    get-by-id/      positive.spec.ts  negative.spec.ts   (unknown id → documented 404)
    patch-by-id/    positive.spec.ts  negative.spec.ts
    delete-by-id/   positive.spec.ts  negative.spec.ts
  health/get/       positive.spec.ts                      (no 4xx documented → no negative file)
  _support/         contract assertions, spec snapshot, items.resource.ts (create / remove helpers)
```

1. **Positive cases** use only spec-provided values. Operations that need an existing resource get it from a **confirmed** dependency: OpenAPI [`links`](https://spec.openapis.org/oas/v3.1.0#link-object) on the create response, or a reviewed deps file (`--deps deps.json`):
   ```json
   { "scenarios": [{ "create": "createItem", "idFrom": "/id", "param": "itemId", "read": "getItem", "update": "updateItem", "delete": "deleteItem" }] }
   ```
   `POST /x` + `GET /x/{id}` without either is reported as an unconfirmed candidate, with the question to answer. Write operations without a confirmed cleanup are not generated at all.
2. **Negative cases** need two things from the spec: a rule to break (required, type, min/max, length, enum, maxItems, additionalProperties, minProperties, security) and a documented rejection (400/422/4XX, 404, 401). Each case breaks exactly one rule of a valid payload and names its source. No documented rejection → only `positive.spec.ts`, and the report says why.
3. Payloads come from schema `example` / `default` / `enum`, then minimal values that satisfy simple constraints; each value's source is in the helper's header. A constraint that cannot be met deterministically blocks the scenario.
4. Created data is removed in `finally`, including records a broken API wrongly accepted in negative tests.
5. Every response is validated against the spec (status, content type, JSON schema with `$ref`, `nullable`, formats). Failures are tagged `CONTRACT_MISMATCH`.
6. Anything asserted that the spec does not state is marked `ASSUMPTION` for the reviewer.

Generated files are overwritten when the spec changes; put hand-written cases in separate files. The same layout and rules are available to Claude Code as a skill: [`skills/api-test-writer/SKILL.md`](skills/api-test-writer/SKILL.md) (copy it to `.claude/skills/` in your test repository).

`generate --draft-pr` commits the tests and the report on a new branch and opens a GitHub Draft PR. It never pushes to the default branch or merges.

## Options

| Option | Default | |
|---|---|---|
| `-u, --base-url` | | test environment URL; required for any network check |
| `--probe` | off | one safe request per GET operation, using only spec-provided values |
| `--schemathesis` | off | bounded generative contract run |
| `--allow-write` | off | allow POST/PUT/PATCH/DELETE |
| `--max-requests`, `--rps`, `--timeout` | 100, 5, 10s | probe budget and limits |
| `--max-examples`, `--max-time`, `--seed` | 25, 120s, 42 | Schemathesis budget, reproducible seed |
| `--fail-on` | `mismatch` | `mismatch` / `blocked` / `never` |
| `--deps`, `--tests-dir`, `--run`, `--draft-pr` | | `generate` only |

Credentials: `API_TOKEN` (bearer / OAuth2 / OIDC), `API_USER` + `API_PASSWORD` (basic), `API_KEY` (apiKey header or query).

## Project layout

```
src/spec/        load, bundle, validate (swagger-parser), lint (Redocly), operation catalogue
src/audit/       SafeClient, probe, Schemathesis runner + JUnit/JSON parsing, auth + redaction
src/contract/    response validator (Ajv), copied verbatim into generated suites
src/generate/    dependency graph, deterministic payloads, Playwright templates, runner
src/report/      JSON + Markdown report
demo-api/        in-memory target API and its OpenAPI spec
tests/unit/      Vitest unit tests
```

## Roadmap

- **Stage 2:** more scenario shapes (list-after-create, PUT, nested resources), Schemathesis config export for CI, re-analyse only operations changed since the last spec hash.
- **Stage 3:** optional AI adapter for unconfirmed dependencies, given only the operation, nearby schemas and the open question, with per-task token limits; `BLOCKED` when confidence is low.
- **Stage 4:** Jira / GitHub / Telegram triggers and notifications.

Not planned for the MVP: auto-fixing a bad spec, accepting observed behaviour as correct, merging without review.

## License

MIT
