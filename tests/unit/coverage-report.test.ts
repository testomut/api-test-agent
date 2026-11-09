import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { generate } from '../../src/generate/generate.js';
import { GAP_CODES, positiveCode, summarize } from '../../src/generate/coverage.js';
import { validateScenarios } from '../../src/scenarios/dsl.js';

/** Stage 10 (docs/SUPPORT_MATRIX.md): coverage reporting with machine codes. */

async function run(file: string, deps?: string, scenarios?: string) {
  const spec = await loadSpec(file);
  const ops = buildCatalog(spec.doc);
  const sc = scenarios ? validateScenarios(JSON.parse(await readFile(scenarios, 'utf8')), ops).scenarios : undefined;
  return generate(spec, ops, { outDir: await mkdtemp(join(tmpdir(), 'ata-cov-')), version: 'test', deps: deps ? JSON.parse(await readFile(deps, 'utf8')) : undefined, maxCases: 500, scenarios: sc });
}

describe('stage 10: coverage report', () => {
  it('every gap and every empty suite has a known machine code', async () => {
    const r = await run('tests/fixtures/coverage/kitchen-sink.yaml', 'tests/fixtures/coverage/kitchen-sink.deps.json');
    for (const c of r.coverage) {
      for (const g of c.gaps) expect(GAP_CODES, `${c.operation} ${g.location}`).toContain(g.code);
      for (const s of Object.values(c.suites)) if (s.missingCode) expect(GAP_CODES).toContain(s.missingCode);
      for (const u of c.uncheckedStatuses) expect(GAP_CODES).toContain(u.code);
      if (c.positiveBlocked) expect(c.positiveBlockedCode).not.toBeNull();
    }
  });

  it('the synthetic fixture has exactly the expected gaps (a new or vanished gap fails)', async () => {
    const r = await run('tests/fixtures/coverage/kitchen-sink.yaml', 'tests/fixtures/coverage/kitchen-sink.deps.json');
    expect(summarize(r.coverage)).toEqual(JSON.parse(await readFile('tests/fixtures/coverage/kitchen-sink.expected-gaps.json', 'utf8')));
  });

  it('the demo API has exactly the expected gaps', async () => {
    const r = await run('demo-api/openapi.yaml', undefined, 'demo-api/scenarios.json');
    expect(summarize(r.coverage)).toEqual(JSON.parse(await readFile('demo-api/expected-gaps.json', 'utf8')));
  });

  it('reports unchecked statuses, request media types and security alternatives', async () => {
    const r = await run('tests/fixtures/coverage/kitchen-sink.yaml', 'tests/fixtures/coverage/kitchen-sink.deps.json');
    const list = r.coverage.find((c) => c.operation === 'GET /orders')!;
    expect(list.uncheckedStatuses).toEqual([
      { status: '403', code: 'UNCONFIRMED_BUSINESS_RULE' },
      { status: '429', code: 'UNSAFE_LIVE_CHECK' },
    ]);
    const update = r.coverage.find((c) => c.operation === 'PUT /orders/{orderId}')!;
    expect(update.uncheckedStatuses).toEqual([{ status: '418', code: 'UNREACHABLE_RESPONSE_STATUS' }]);
    const multi = { ...buildCatalog((await loadSpec('tests/fixtures/coverage/kitchen-sink.yaml')).doc)[0], requestContentTypes: ['application/json', 'multipart/form-data'], security: [['bearer'], ['apiKey']] } as any;
    const { uncheckedRequest } = await import('../../src/generate/coverage.js');
    expect(uncheckedRequest(multi)).toEqual({ contentTypes: ['multipart/form-data'], securityAlternatives: [['apiKey']] });
  });

  it('positive-blocked reasons map to codes', () => {
    expect(positiveCode('POST /x changes data and has no confirmed precondition/cleanup (no OpenAPI links or deps file).')).toBe('MISSING_CLEANUP');
    expect(positiveCode('Path "id" would come from a spec example, not from a real record')).toBe('MISSING_RESOURCE_SOURCE');
    expect(positiveCode('No example-backed payload for PUT /x')).toBe('MISSING_VALID_SAMPLE');
    expect(positiveCode('GET /logout ends the session shared by the other tests')).toBe('UNSAFE_LIVE_CHECK');
    expect(positiveCode('Operation is deprecated.')).toBe('DEPRECATED_OPERATION');
    expect(positiveCode(undefined)).toBeNull();
  });
});
