# Legacy pytest project example

A pytest + requests API test project in a typical "before" state, used to demonstrate `api-test-agent run` on Python tests:

- `conftest.py`: an `api` session fixture and an `item` fixture that creates an item and deletes it after the test (`yield`).
- `helpers/inventory_client.py`: an API client wrapper used by the tests.
- `tests/test_items.py`: module-level state shared between tests, a hard-coded token, `time.sleep`, status-only checks and no cleanup.
- `tests/test_item_lifecycle.py`: a test class with `setup_method` / `teardown_method`, and a test using the `item` fixture.
- `tests/test_validation.py`: a negative case.

```sh
npm run demo                                       # terminal 1, from the repository root
cd examples/legacy-pytest-project                  # terminal 2
npx @testomut/api-test-agent init --yes --base-url http://localhost:3100 --spec ../../demo-api/openapi.yaml --lang python
npx @testomut/api-test-agent run
```
