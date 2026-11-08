---
name: api-test-writer
description: Write or extend Playwright + TypeScript API tests for an endpoint in the project's folder layout (<resource>/<method>[-by-id]/positive.spec.ts and negative.spec.ts). Use when the user asks to write, add, cover or extend API tests for an endpoint, a user story or an OpenAPI operation, or to add negative / boundary / validation cases. Not for UI or E2E browser tests.
---

# API test writer

Write API tests the way this project lays them out, from sources that can be shown, never from guesses.

## 1. Folder layout (mandatory)

One folder per resource, one folder per operation, one file per kind of case:

```
tests/api/
  orders/                    ← static path segments joined with "-": /orders → orders, /admin/reset → admin-reset
    get/                     ← GET /orders
      positive.spec.ts
      negative.spec.ts
    get-by-id/               ← GET /orders/{orderId}: path ends with a parameter → "<method>-by-id"
      positive.spec.ts
      negative.spec.ts
    post/
      positive.spec.ts
      negative.spec.ts       ← only if negative cases are possible (see 3)
  _support/                  ← shared: contract assertions, <resource>.resource.ts data helpers
```

- `positive.spec.ts`: the operation works as documented with valid input.
- `negative.spec.ts`: the operation rejects invalid input as documented.
- If no negative case is possible, create **only** `positive.spec.ts` and tell the user why in one line.
- If a positive case is impossible (missing test data, unknown dependency), create only what is possible and state the blocker as a concrete question.
- Two operations that would land in the same folder: suffix the folder with the operationId.
- **Language** follows `API_TESTS_LANG` in `.env` (default TypeScript). For Python (pytest + requests) the same layout uses underscores and pytest names: `orders/get_by_id/test_positive.py` and `test_negative.py`, an `__init__.py` in each folder, shared fixtures in `tests/api/conftest.py` (`api`, `anonymous_api`, `contract`, `<resource>`, `created_<resource>`), negative cases with `pytest.mark.parametrize`, cleanup in fixture teardown. Hand-written files: `test_positive_manual.py`.

## 2. Before writing: read, do not assume

1. Find the source of expectations: OpenAPI operation (request schema, documented responses, `links`), the user story, or the user's words. Quote it in a comment at the top of the file.
2. Read the project's existing `_support/` helpers, fixtures and one neighbouring test. Reuse them; do not create a second helper that does the same thing. Match naming and style.
3. If `api-test-agent` is installed, run `npx @testomut/api-test-agent generate <spec> --tests-dir tests/api` first and extend its output, rather than writing the same cases by hand. Hand-written cases go into separate files (e.g. `positive.manual.spec.ts`), because generated files are overwritten when the spec changes.

## 3. When negative cases are allowed

A negative case needs BOTH:

- a rule written down to break: `required`, `type`, `minLength/maxLength`, `minimum/maximum`, `enum`, `maxItems`, `additionalProperties: false`, `minProperties`, required query/path params, security;
- a documented rejection for that operation: `400`/`422`/`4XX` for validation, `404` for an unknown id, `401`/`403` for missing or foreign credentials.

No documented rejection → no negative case. Do not invent "should return 400" because it seems reasonable: ask the user, or note it as a spec gap.

Per case, break **exactly one** rule, starting from a valid payload. Name the case after the rule (`missing required field "name"`, `"price" below minimum 0`) and keep a `source` pointing to the schema location. Prefer a data-driven array + loop over copy-pasted tests.

Typical set per operation:
| Operation | Cases |
|---|---|
| POST / PUT / PATCH with body | each required field missing, wrong type per field, each min/max/length/enum bound ±1, unknown field, empty object if `minProperties` |
| GET with query params | wrong type, below minimum, above maximum, not in enum, required param missing |
| any `…/{id}` | non-existent id → documented 404 (uuid format → random uuid) |
| secured operation | no credentials → documented 401; other user's resource → documented 403 |

## 4. House rules for every test

- **Data:** create preconditions through the API with the documented example payload; never rely on pre-existing records unless the user says a fixed test dataset exists.
- **Cleanup:** delete what the test created in `finally` (or a fixture teardown), even when an assertion fails. A negative create test that the API wrongly accepted must delete the created record too.
- **Assertions:** check the documented status code AND the response contract (schema, content type), plus the business fact the test is about (same id returned, updated value persisted). `status 200` alone is not a test.
- **Isolation:** tests must pass with `fullyParallel: true`; no shared mutable state, no ordering between files.
- **No waits:** never `waitForTimeout`; poll with `expect.poll` only for documented eventual consistency.
- **Secrets:** credentials only from environment variables; never hard-code tokens, never log request bodies with personal data.
- **Assumptions:** anything asserted that the source does not state gets a `// ASSUMPTION:` comment and is listed for the reviewer.
- **Never** weaken or delete an assertion to make a test pass. A failing test against the documented contract is a finding: report it (status, endpoint, expected vs actual, quote of the spec).
- **Never** send write requests to an operation without known cleanup, or to production.

## 5. Finish

Tell the user, briefly:
- files created (paths) and the number of cases in each;
- which operations have only a positive (or only a negative) file, and why;
- assumptions to confirm and blockers as precise questions;
- the command to run them: `npx playwright test tests/api/<resource>`.
