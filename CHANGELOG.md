# Changelog

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
