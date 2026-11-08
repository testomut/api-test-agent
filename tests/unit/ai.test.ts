import { describe, expect, it } from 'vitest';
import { loadSpec } from '../../src/spec/loader.js';
import { buildCatalog } from '../../src/spec/catalog.js';
import { ClaudeAdvisor, type ParseClient } from '../../src/ai/claude.js';
import { proposeDependencies } from '../../src/ai/dependencies.js';

// Demo spec without OpenAPI links → POST /items + /items/{itemId} becomes an unconfirmed candidate.
const spec = await loadSpec('demo-api/openapi.yaml');
const doc = structuredClone(spec.doc);
delete doc.paths['/items'].post.responses['201'].links;
const ops = buildCatalog(doc);

function fakeClient(answer: unknown, stop = 'end_turn') {
  const calls: any[] = [];
  const client: ParseClient = {
    beta: {
      messages: {
        parse: async (params: any) => {
          calls.push(params);
          return { stop_reason: stop, parsed_output: stop === 'refusal' ? null : answer, usage: { input_tokens: 500, output_tokens: 80 } };
        },
      },
    },
  };
  return { client, calls };
}

describe('AI dependency proposals', () => {
  it('turns a verified answer into a deps-file proposal, never applying it', async () => {
    const { client, calls } = fakeClient({ same_resource: true, id_pointer: '/id', confidence: 'high', reasoning: 'Item.id is a uuid like itemId' });
    const advisor = new ClaudeAdvisor({ maxCalls: 5 }, client);
    const r = await proposeDependencies(doc, ops, advisor, () => undefined);
    expect(r.depsFile.scenarios).toEqual([{ create: 'createItem', idFrom: '/id', param: 'itemId', read: 'getItem', update: 'updateItem', delete: 'deleteItem' }]);
    expect(r.proposals[0].status).toBe('proposed');
    // Request shape: default model, schema-constrained output, server-side fallback.
    expect(calls[0].model).toBe('claude-opus-5-5');
    expect(calls[0].fallbacks).toBe('default');
    expect(calls[0].output_config.format).toBeTruthy();
    expect(advisor.summary()).toMatch(/1 call\(s\), 500 input \/ 80 output tokens, ~\$0\.0036/);
  });

  it('sends names and types only, never example values from the spec', async () => {
    const { client, calls } = fakeClient({ same_resource: true, id_pointer: '/id', confidence: 'high', reasoning: 'x' });
    await proposeDependencies(doc, ops, new ClaudeAdvisor({}, client), () => undefined);
    const sent = JSON.stringify(calls[0].messages);
    expect(sent).toContain('createItem');
    expect(sent).not.toContain('Mechanical keyboard');
    expect(sent).not.toContain('89.9');
  });

  it('rejects an answer the spec does not support', async () => {
    const { client } = fakeClient({ same_resource: true, id_pointer: '/itemId', confidence: 'high', reasoning: 'invented' });
    const r = await proposeDependencies(doc, ops, new ClaudeAdvisor({}, client), () => undefined);
    expect(r.depsFile.scenarios).toEqual([]);
    expect(r.proposals[0].reason).toMatch(/does not exist in the POST \/items response schema/);
  });

  it('rejects low confidence and handles a refusal without guessing', async () => {
    const low = await proposeDependencies(doc, ops, new ClaudeAdvisor({}, fakeClient({ same_resource: true, id_pointer: '/id', confidence: 'low', reasoning: 'unsure' }).client), () => undefined);
    expect(low.proposals[0].reason).toMatch(/confidence is low/);
    const refused = await proposeDependencies(doc, ops, new ClaudeAdvisor({}, fakeClient(null, 'refusal').client), () => undefined);
    expect(refused.proposals[0].status).toBe('rejected');
  });

  it('respects the call budget', async () => {
    const r = await proposeDependencies(doc, ops, new ClaudeAdvisor({ maxCalls: 0 }, fakeClient({}).client), () => undefined);
    expect(r.proposals[0]).toMatchObject({ status: 'not-asked' });
    expect(r.proposals[0].reason).toMatch(/budget/);
  });
});
