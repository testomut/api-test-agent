# Changelog

## Unreleased

- **Optional AI (`--ai` on `generate` and `run`):** Claude proposes answers for unconfirmed dependencies from a minimal excerpt (names and types only), with schema-constrained output, a spec check of every answer, a call budget and a cost summary. Accepted answers are written to `ai-deps.proposed.json` for review; nothing is applied automatically.

## 0.1.2 - 2026-11-08

- **Login-based auth for short-lived tokens:** `API_LOGIN`, `API_LOGIN_BODY` (with `${VAR}` from `.env`), `API_TOKEN_POINTER`. The agent logs in before network checks; generated TypeScript (fixtures) and Python (conftest) suites log in and refresh the token themselves. `init` asks for it.
- Generated 401 tests (TypeScript) now really send no credentials: `newContext()` inside a test inherited the project's auth header.
- Secret redaction covers every TOKEN / PASSWORD / SECRET / API_KEY variable.
- Demo API: `POST /auth/login` (5-minute tokens) and a secured `GET /me`.
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
