import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { generate } from '../../src/generate/generate.js';
import { AiRunner, type Exec } from '../../src/ai/runner.js';
import { proposeSources, reviewedSources, sourceTargets, verifySource } from '../../src/ai/sources.js';

/** AI step on by default: read-only sources of path values, verified against the spec, cached, marked AI-proposed. */

const demo = await loadSpec('demo-api/openapi.yaml');
const ops = buildCatalog(demo.doc);
const op = (k: string) => ops.find((o) => o.key === k)!;
const report = op('GET /reports/{reportId}');

/** A console tool that always gives this answer (runner "command", no real AI). */
const fake = (answer: unknown) => {
  const exec: Exec = async () => ({ code: 0, stdout: JSON.stringify(answer), stderr: '' });
  return new AiRunner({ runner: 'command', command: 'fake-ai', maxCalls: 5 }, exec);
};
const log = () => {};

describe('spec check of a source (AI answer or deps entry)', () => {
  it('accepts a safe list operation, an existing pointer and a fitting type', () => {
    expect(verifySource(demo.doc, ops, report, 'reportId', 'listItems', '/items/0/id').problem).toBeUndefined();
  });

  it('rejects what the spec does not support, never guessing', () => {
    expect(verifySource(demo.doc, ops, report, 'reportId', 'nope', '/items/0/id').problem).toContain('is not in the spec');
    expect(verifySource(demo.doc, ops, report, 'reportId', 'createItem', '/id').problem).toContain('not a safe list operation');
    expect(verifySource(demo.doc, ops, report, 'reportId', 'listItems', '/items/0/missing').problem).toContain('does not exist');
    expect(verifySource(demo.doc, ops, report, 'reportId', 'listItems', '/items/0/price').problem).toContain('type mismatch');
    expect(verifySource(demo.doc, ops, report, 'other', 'listItems', '/items/0/id').problem).toContain('no path parameter');
  });

  it('a deps-file source with a problem is reported, never used', () => {
    const r = reviewedSources(demo.doc, ops, [{ operationId: 'getReport', param: 'reportId', from: 'listItems', pointer: '/nope' }]);
    expect(r.sources).toEqual([]);
    expect(r.errors[0].reason).toContain('does not exist');
  });
});

describe('the AI step', () => {
  const targets = sourceTargets(ops, () => false);

  it('targets only safe operations blocked by one unknown path value', () => {
    expect(targets.map((t) => `${t.op.key} ${t.param}`)).toEqual(['GET /items/{itemId} itemId', 'GET /reports/{reportId} reportId']);
  });

  it('uses a verified answer, rejects a low-confidence one, and replays the cache without AI', async () => {
    const one = [{ op: report, param: 'reportId' }];
    const good = await proposeSources(demo.doc, ops, one, fake({ from: 'listItems', pointer: '/items/0/id', confidence: 'high', reasoning: 'r' }), {}, log);
    expect(good.sources.map((s) => [s.from.key, s.pointer, s.ai])).toEqual([['GET /items', '/items/0/id', true]]);
    expect(good.proposals[0].status).toBe('used');
    const low = await proposeSources(demo.doc, ops, one, fake({ from: 'listItems', pointer: '/items/0/id', confidence: 'low', reasoning: 'r' }), {}, log);
    expect(low.sources).toEqual([]);
    expect(low.proposals[0].reason).toBe('model confidence is low');
    const bad = await proposeSources(demo.doc, ops, one, fake({ from: 'listItems', pointer: '/total', confidence: 'high', reasoning: 'r' }), {}, log);
    expect(bad.proposals[0].reason).toContain('rejected by the spec check');
    // No AI available: the cached answer gives the same source; an uncached target is simply not asked.
    const replay = await proposeSources(demo.doc, ops, one, undefined, good.cache, log);
    expect(replay.sources.map((s) => s.pointer)).toEqual(['/items/0/id']);
    expect(replay.proposals[0].status).toBe('cached');
    const without = await proposeSources(demo.doc, ops, one, undefined, {}, log);
    expect(without.sources).toEqual([]);
    expect(without.proposals[0]).toEqual(expect.objectContaining({ status: 'not-asked', reason: 'AI not available' }));
  });

  it('a broken tool stops the AI step, not the run', async () => {
    const exec: Exec = async () => ({ code: 1, stdout: '', stderr: 'not logged in' });
    const r = await proposeSources(demo.doc, ops, targets, new AiRunner({ runner: 'command', command: 'x' }, exec), {}, log);
    expect(r.sources).toEqual([]);
    expect(r.proposals.every((p) => p.status === 'not-asked')).toBe(true);
  });
});

describe('generated read-only tests from a source', () => {
  it('list → read by id, skipped without data or when the source is refused, marked AI-proposed, same cases in TS and Python', async () => {
    const r = await proposeSources(demo.doc, ops, [{ op: report, param: 'reportId' }], fake({ from: 'listItems', pointer: '/items/0/id', confidence: 'high', reasoning: 'r' }), {}, log);
    const gen = async (lang: 'typescript' | 'python') => {
      const dir = await mkdtemp(join(tmpdir(), 'ata-ai-'));
      const res = await generate(demo, ops, { outDir: dir, version: 'test', lang, sources: r.sources, aiCache: r.cache });
      return { dir, res, read: (f: string) => readFile(join(dir, f), 'utf8') };
    };
    const ts = await gen('typescript');
    const py = await gen('python');
    const fn = await ts.read('reports/get-by-id/functional.spec.ts');
    expect(fn).toContain("const value = readPointer(await source.json(), '/items/0/id');");
    expect(fn).toContain("test.skip(!source.ok(),");
    expect(fn).toContain("type: 'ai-proposed'");
    expect(fn).toContain('String(value)');
    expect(await py.read('reports/get_by_id/test_functional.py')).toContain('@pytest.mark.ai_proposed');
    const cov = ts.res.coverage.find((c) => c.operation === 'GET /reports/{reportId}')!;
    expect(cov.positiveBlocked).toBeNull();
    expect(cov.aiProposed).toEqual([expect.objectContaining({ kind: 'source', from: 'GET /items', pointer: '/items/0/id' })]);
    const active = async (g: typeof ts) => Object.entries<any>(JSON.parse(await g.read('_support/cases.json')).cases).filter(([, c]) => c.status !== 'retired').map(([id]) => id).sort();
    expect(await active(py)).toEqual(await active(ts));
    expect(JSON.parse(await ts.read('_support/ai-sources.json')).answers).toEqual(r.cache);
  });
});
