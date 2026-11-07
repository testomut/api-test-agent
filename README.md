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

## Quick start

```sh
npm install
python -m venv .venv && .venv/Scripts/pip install schemathesis   # macOS/Linux: .venv/bin/pip

npm run demo            # in-memory Inventory Demo API on http://localhost:3100

# Static analysis only (no network)
npx tsx src/cli.ts audit demo-api/openapi.yaml

# Read-only probe + bounded Schemathesis run against the test environment
npx tsx src/cli.ts audit demo-api/openapi.yaml -u http://localhost:3100 --probe --schemathesis

# Generate Playwright tests for confirmed CRUD chains and run them once
npx tsx src/cli.ts generate demo-api/openapi.yaml -u http://localhost:3100 --allow-write --run

npm run test:api        # the generated suite is plain Playwright and runs without the agent
```

The demo API contains one deliberate defect (`GET /stats` returns `total` as a string) and two operations that are hard to test on purpose (`/admin/reset` needs a token, `/reports/{reportId}` has no response schema and no way to obtain an id). Start it with `DEMO_BREAK=create-price` to simulate a regression and watch the generated test report `CONTRACT_MISMATCH POST /items (schema): /price must be number`.

## What the demo run reports

| Operation | Probe | Schemathesis | Functional |
|---|---|---|---|
| `GET /health`, `GET /items` | PASS | PASS | - |
| `GET /stats` | **CONTRACT_MISMATCH** | **CONTRACT_MISMATCH** (ST108) | - |
| `GET /items/{itemId}` | BLOCKED: no value for `itemId` | BLOCKED: only 404s, core logic never reached | PASS (CRUD chain) |
| `POST/PATCH/DELETE /items…` | NOT_RUN (read-only probe) | NOT_RUN without `--allow-write` | PASS (CRUD chain) |
| `GET /reports/{reportId}` | BLOCKED | BLOCKED | - |
| `POST /admin/reset` | NOT_RUN | NOT_RUN | - |

Note the `GET /items/{itemId}` row: Schemathesis exits green for it, but every request returned 404, so the tool reports `BLOCKED` rather than a misleading `PASS`.

## How functional tests are generated

1. A dependency is **confirmed** only when it is written down: OpenAPI [`links`](https://spec.openapis.org/oas/v3.1.0#link-object) on the create response, or a reviewed deps file (`--deps deps.json`):
   ```json
   { "scenarios": [{ "create": "createItem", "idFrom": "/id", "param": "itemId", "read": "getItem", "update": "updateItem", "delete": "deleteItem" }] }
   ```
   `POST /x` + `GET /x/{id}` without either is reported as an unconfirmed candidate, with the question to answer.
2. Payloads come from schema `example` / `default` / `enum`, then minimal values that satisfy simple constraints. Each value's source is written as a comment in the test. A constraint that cannot be met deterministically (for example a `pattern` with no example) blocks the scenario.
3. A chain with no delete operation is blocked: created data must be cleaned up. Cleanup runs in `finally`, even when an assertion fails.
4. Every response is validated against the spec (status, content type, JSON schema with `$ref`, `nullable`, formats).
5. Anything asserted that the spec does not state (for example "after PATCH, GET returns the new values") is listed as an `ASSUMPTION` in the test header and in the report, for the reviewer.

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
