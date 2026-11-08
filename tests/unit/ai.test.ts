import { describe, expect, it } from 'vitest';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { AiRunner, parseJsonLoose, resolveCli, type Exec } from '../../src/ai/runner.js';
import { proposeDependencies } from '../../src/ai/dependencies.js';

// Demo spec without OpenAPI links → POST /items + /items/{itemId} becomes an unconfirmed candidate.
const spec = await loadSpec('demo-api/openapi.yaml');
const doc = structuredClone(spec.doc);
delete doc.paths['/items'].post.responses['201'].links;
const ops = buildCatalog(doc);

/** Fake console tool for the `command` runner: records the request, answers with `answer`. */
function fakeCommand(answer: unknown, code = 0) {
  const calls: { command: string; args: string[]; input: string; cwd: string }[] = [];
  const exec: Exec = async (command, args, o) => {
    calls.push({ command, args, input: o.input, cwd: o.cwd });
    return { code, stdout: typeof answer === 'string' ? answer : JSON.stringify(answer), stderr: code ? 'boom' : '' };
  };
  return { runner: (max = 10) => new AiRunner({ runner: 'command', command: 'my-orchestrator', maxCalls: max }, exec), calls };
}

describe('AI via console tools (no API keys)', () => {
  it('turns a verified answer into a deps-file proposal, never applying it', async () => {
    const f = fakeCommand({ same_resource: true, id_pointer: '/id', confidence: 'high', reasoning: 'Item.id is a uuid like itemId' });
    const runner = f.runner();
    const r = await proposeDependencies(doc, ops, runner, () => undefined);
    expect(r.depsFile.scenarios).toEqual([{ create: 'createItem', idFrom: '/id', param: 'itemId', read: 'getItem', update: 'updateItem', delete: 'deleteItem' }]);
    expect(r.proposals[0].status).toBe('proposed');
    expect(runner.summary()).toMatch(/via command: 1 answer\(s\), 0 without a valid answer/);
  });

  it('follows the orchestrator contract: {system, prompt, schema} on stdin, in an empty temp folder', async () => {
    const f = fakeCommand({ same_resource: true, id_pointer: '/id', confidence: 'high', reasoning: 'x' });
    await proposeDependencies(doc, ops, f.runner(), () => undefined);
    const req = JSON.parse(f.calls[0].input);
    expect(Object.keys(req)).toEqual(['system', 'prompt', 'schema']);
    expect(req.schema.required).toContain('id_pointer');
    expect(f.calls[0].cwd).toMatch(/api-agent-ai-/);
  });

  it('sends names and types only, never example values from the spec', async () => {
    const f = fakeCommand({ same_resource: true, id_pointer: '/id', confidence: 'high', reasoning: 'x' });
    await proposeDependencies(doc, ops, f.runner(), () => undefined);
    expect(f.calls[0].input).toContain('createItem');
    expect(f.calls[0].input).not.toContain('Mechanical keyboard');
    expect(f.calls[0].input).not.toContain('89.9');
  });

  it('rejects an answer the spec does not support, and low confidence', async () => {
    const invented = await proposeDependencies(doc, ops, fakeCommand({ same_resource: true, id_pointer: '/itemId', confidence: 'high', reasoning: 'x' }).runner(), () => undefined);
    expect(invented.proposals[0].reason).toMatch(/does not exist in the POST \/items response schema/);
    const low = await proposeDependencies(doc, ops, fakeCommand({ same_resource: true, id_pointer: '/id', confidence: 'low', reasoning: 'x' }).runner(), () => undefined);
    expect(low.proposals[0].reason).toMatch(/confidence is low/);
  });

  it('treats an answer that breaks the schema as no answer (never guesses)', async () => {
    const r = await proposeDependencies(doc, ops, fakeCommand({ same_resource: 'yes', id_pointer: 1 }).runner(), () => undefined);
    expect(r.proposals[0].status).toBe('rejected');
    expect(r.depsFile.scenarios).toEqual([]);
  });

  it('reports a failing tool and respects the call budget', async () => {
    const failed = await proposeDependencies(doc, ops, fakeCommand('', 1).runner(), () => undefined);
    expect(failed.proposals[0]).toMatchObject({ status: 'not-asked' });
    expect(failed.proposals[0].reason).toMatch(/exited with 1/);
    const budget = await proposeDependencies(doc, ops, fakeCommand({}).runner(0), () => undefined);
    expect(budget.proposals[0].reason).toMatch(/budget/);
  });

  it('reads JSON answers wrapped in text', () => {
    expect(parseJsonLoose('Here you go:\n{"a":1}\nThanks')).toEqual({ a: 1 });
    expect(parseJsonLoose('no json')).toBeUndefined();
  });
});

describe.skipIf(!resolveCli('claude'))('claude runner (Claude Code installed here)', () => {
  it('calls claude -p with a JSON schema, no tools and no session, and reads structured_output', async () => {
    let seen: { command: string; args: string[] } | undefined;
    const exec: Exec = async (command, args) => {
      seen = { command, args };
      return { code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.01, structured_output: { same_resource: true, id_pointer: '/id', confidence: 'high', reasoning: 'x' } }), stderr: '' };
    };
    const runner = new AiRunner({ runner: 'claude' }, exec);
    const r = await proposeDependencies(doc, ops, runner, () => undefined);
    expect(r.depsFile.scenarios).toHaveLength(1);
    expect(seen!.command).not.toMatch(/\.cmd$/i); // the real executable, not the npm shim
    const a = seen!.args;
    expect(a).toEqual(expect.arrayContaining(['-p', '--output-format', 'json', '--json-schema', '--no-session-persistence']));
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    expect(runner.summary()).toMatch(/reported cost ~\$0\.0100/);
  });
});
