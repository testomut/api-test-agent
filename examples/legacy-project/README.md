# Legacy project example

A small test project in a typical "before" state, used to demonstrate `api-test-agent run`:

- `tests/items.test.ts`: API tests with a shared `beforeAll`, a hard-coded token, status-only checks, no cleanup and two tests that depend on each other.
- `tests/items-lifecycle.spec.ts`: a cleaner test using a fixture (`fixtures.ts`) and helpers (`helpers/items-api.ts`).
- `tests/e2e/home.spec.ts`: a UI test. It is listed and never modified.
- `postman/inventory.postman_collection.json`: requests chained through `{{itemId}}`, plus an endpoint that is not in the spec.

Try it against the demo API (from the repository root):

```sh
npm run demo                                  # terminal 1
cd examples/legacy-project                    # terminal 2
npx @testomut/api-test-agent init --yes --base-url http://localhost:3100 --spec ../../demo-api/openapi.yaml --postman postman/inventory.postman_collection.json
npx @testomut/api-test-agent run
```
