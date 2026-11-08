# Changelog

## Unreleased

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
