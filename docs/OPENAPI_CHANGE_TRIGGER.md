# OpenAPI change-triggered incremental generation (design)

Status: **proposed architecture**, not implemented. The existing CLI behavior remains unchanged.

## Goal

When an OpenAPI specification changes in a pull request, CI should identify *semantic* changes and propose only the relevant test updates. Never silently rewrite assertions to match a new spec.

## Pipeline

1. A repository webhook starts Jenkins on a PR; Jenkins uses a path filter for OpenAPI files (and an explicit manual trigger for non-file specs).
2. Fetch the **base-branch** OpenAPI document and the PR's document. Resolve references and normalize both; compare operation identity by HTTP method + path (not just operationId).
3. Emit a machine-readable `OpenApiChangeSet` with added/removed operations, request parameter/body changes, response status/schema changes, and potential breaking changes. Track renamed operationIds separately.
4. Map changes to stable test-plan case IDs and operation IDs. Include dependent scenarios using the dependency graph; distinguish confirmed edges (OpenAPI links/reviewed deps) from candidates.
5. Produce a **review-only** test plan and proposed test file changes. If existing tests already cover the change, report that instead of regenerating. Never delete or rewrite existing assertions automatically.
6. Publish report artifacts and optionally open a draft PR for human review. The agent should not push changes back to the triggering PR by default.

## Internal types (proposed)

```ts
type OpenApiChange = {
  kind: 'operation-added' | 'operation-removed' | 'parameter-changed' |
        'request-changed' | 'response-changed' | 'operation-renamed';
  operationKey: string; // METHOD + normalized path
  pointer?: string;     // JSON Pointer to changed component
  before?: unknown;
  after?: unknown;
  breaking: 'yes' | 'no' | 'unknown';
};

type OpenApiChangeSet = {
  baseRevision: string;
  headRevision: string;
  changes: OpenApiChange[];
};

type TestImpact = {
  caseId: string;
  operationKey: string;
  action: 'add' | 'review' | 'no-change' | 'blocked';
  reason: string;
  affectedScenarios: string[];
};
```

Use the same normalized API model as the Test Plan and dependency graph. Keep stable IDs across generation runs so incremental updates do not duplicate tests. This design does **not** require AI.

## Jenkins integration sketch (future, not runnable as-is)

- Configure a multibranch Pipeline or PR webhook in Jenkins; configure credentials and repository checkout externally.
- Gate analysis on changed OpenAPI files; compare the PR head with the **merge base**, not just the previous build.
- Invoke future CLI commands such as `api-test-agent diff --base <base-spec> --head <head-spec> --format json` and `api-test-agent plan --changes <changes.json>` (these commands **do not exist yet**).
- Archive `changes.json`, `test-impact.json`, and a Markdown report; fail on breaking changes only when the team's policy explicitly requests it.
- For PRs from untrusted forks, do not expose secrets or run generated code with privileged credentials.

## Safety and acceptance criteria

- Changes to formatting, ordering, or descriptions alone should not generate new tests.
- A new required parameter creates parameter test cases; changed response schema impacts contract tests; modified resource lifecycle edges flag dependent scenarios.
- Deletions and breaking changes require review, never automatic expectation updates.
- Missing specs, unresolved references, ambiguous mappings, and unconfirmed dependencies produce explicit BLOCKED/review items.
- Default mode performs static analysis only: no network calls, writes, or CI secret access.
- CLI integration must be additive and preserve existing published npm commands.
- Unit tests should cover added/removed endpoints, required vs optional parameters, response changes, schema refs, path/operationId renames, and unchanged specs.

## Implementation order

1. Define normalized operation IDs and Test Plan case IDs.
2. Implement semantic OpenAPI diff with unit tests.
3. Implement change-to-test impact mapping, including graph traversal.
4. Add CLI reporting and dry-run proposal generation.
5. Add an example Jenkinsfile and optional draft-PR integration.
