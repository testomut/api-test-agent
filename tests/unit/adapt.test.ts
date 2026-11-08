import { describe, expect, it } from 'vitest';
import { analyzeProject } from '../../src/discover/analyze.js';
import { buildPlan, removeRanges, rewriteRelativeImports } from '../../src/adapt.js';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';

const spec = await loadSpec('demo-api/openapi.yaml');
const ops = buildCatalog(spec.doc);

describe('adapt helpers', () => {
  it('removes whole tests by line range and tidies blank lines', () => {
    const src = ['a', '', 'test1', 'test1', '', 'test2', ''].join('\n');
    expect(removeRanges(src, [{ start: 3, end: 4 }])).toBe('a\n\n\ntest2\n');
  });

  it('re-points relative imports when a file moves', () => {
    const src = "import { test } from '../fixtures';\nimport x from '@playwright/test';\nconst h = require('./helpers/a');";
    const out = rewriteRelativeImports(src, 'tests/items.spec.ts', 'tests/api/items/get/positive.items.spec.ts');
    expect(out).toContain("from '../../../../fixtures'");
    expect(out).toContain("from '@playwright/test'");
    expect(out).toContain("require('../../../helpers/a')");
  });
});

describe('adapt plan (Playwright example)', async () => {
  const root = 'examples/legacy-project';
  const analysis = await analyzeProject({ root, testsDir: 'tests/api', doc: spec.doc, ops });
  const plan = buildPlan({ root, analysis, ops, testsDir: 'tests/api', lang: 'typescript' });
  const created = plan.changes.filter((c) => c.action === 'create').map((c) => c.path);

  it('moves each test next to its operation, named after the source file', () => {
    expect(created).toEqual(expect.arrayContaining([
      'tests/api/items/post/negative.items.spec.ts',
      'tests/api/items/patch-by-id/positive.items.spec.ts',
      'tests/api/items/delete-by-id/positive.items-lifecycle.spec.ts',
    ]));
  });

  it('keeps tests that share state, and says why', () => {
    expect(plan.skipped.map((s) => s.what).join()).toContain('create second item');
    expect(plan.changes.find((c) => c.path === 'tests/items.test.ts')?.action).toBe('rewrite');
    expect(plan.changes.find((c) => c.path === 'tests/items-lifecycle.spec.ts')?.action).toBe('delete');
  });

  it('keeps hooks and shared variables in each moved copy, removes the other tests', () => {
    const c = plan.changes.find((x) => x.path === 'tests/api/items/patch-by-id/positive.items.spec.ts')!.content!;
    expect(c).toContain('test.beforeAll');
    expect(c).toContain("test('update item price'");
    expect(c).not.toContain("test('get item'");
  });

  it('converts only Postman requests that need no guessing', () => {
    expect(created).toContain('tests/api/health/get/positive.postman.spec.ts');
    expect(plan.skipped.some((s) => s.what.includes('Postman'))).toBe(false); // chained requests are already covered by tests
  });
});
