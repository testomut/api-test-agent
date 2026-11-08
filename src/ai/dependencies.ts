import { z } from 'zod';
import type { Operation } from '../types.js';
import { resolvePointer, type OpenApiDoc } from '../spec/loader.js';
import { operationPointer } from '../spec/catalog.js';
import { findChains, type DepsFile } from '../generate/graph.js';
import { ClaudeAdvisor, describeAiError } from './claude.js';

/**
 * AI step for UNCONFIRMED dependencies only (POST /x + /x/{param} with no OpenAPI links and no
 * deps file). The model sees a minimal excerpt (operation keys, ids, the create response's
 * top-level property names/types, the path parameter's schema) - no example values, no data.
 * Its answer is checked against the spec, then written as a PROPOSAL; nothing is applied
 * until a human reviews it and passes it with --deps.
 */

export const DependencyAnswer = z.object({
  same_resource: z.boolean().describe('true only if the excerpt shows the item path addresses the resource the create operation returns'),
  id_pointer: z.string().nullable().describe('JSON pointer into the create response body that holds the identifier, e.g. "/id"; null if not established'),
  confidence: z.enum(['high', 'medium', 'low']),
  reasoning: z.string().describe('one or two sentences, citing only names from the excerpt'),
});
export type DependencyAnswerT = z.infer<typeof DependencyAnswer>;

export const SYSTEM_PROMPT = `You review REST API specifications for an API test generator.
You get an excerpt about one "create" operation and operations on an item path with a path parameter.
Decide whether the path parameter is the identifier returned by the create operation, and where that identifier is in the create response.
Rules:
- Use only names and types that appear in the excerpt. Never invent fields.
- If the excerpt does not establish the link (no matching field, mismatched types, ambiguous candidates), answer same_resource=false or confidence "low".
- id_pointer is a JSON pointer such as "/id" or "/data/id" into the create response body.`;

export interface DependencyProposal {
  create: string; // operationId or key
  itemOperations: string[];
  param: string;
  answer?: DependencyAnswerT;
  status: 'proposed' | 'rejected' | 'not-asked';
  reason: string;
}

const deref = (doc: OpenApiDoc, s: any): any => (s?.$ref ? deref(doc, resolvePointer(doc, s.$ref.slice(1)).node) : s);
const typeOf = (s: any): string | undefined => (Array.isArray(s?.type) ? s.type.find((t: string) => t !== 'null') : s?.type);

function successSchema(doc: OpenApiDoc, op: Operation): any {
  const responses = resolvePointer(doc, `${operationPointer(op)}/responses`).node ?? {};
  for (const [status, r] of Object.entries<any>(responses)) {
    if (!/^2\d\d$/.test(status)) continue;
    const resp = deref(doc, r);
    const media = Object.keys(resp?.content ?? {}).find((k) => k.includes('json'));
    if (media) return deref(doc, resp.content[media].schema);
  }
  return undefined;
}

/** Top-level (and one nested level) property names and types: names only, never example values. */
function shape(doc: OpenApiDoc, schema: any, depth = 0): Record<string, string> {
  const out: Record<string, string> = {};
  const s = deref(doc, schema);
  for (const [name, raw] of Object.entries<any>(s?.properties ?? {})) {
    const p = deref(doc, raw);
    out[name] = [typeOf(p) ?? 'any', p?.format].filter(Boolean).join(':');
    if (depth === 0 && typeOf(p) === 'object') for (const [k, v] of Object.entries(shape(doc, p, 1))) out[`${name}.${k}`] = v;
  }
  return out;
}

/** Deterministic check of an AI answer against the spec. */
export function verifyAnswer(doc: OpenApiDoc, create: Operation, paramSchema: any, answer: DependencyAnswerT): string | undefined {
  if (!answer.same_resource) return 'model says the operations are not linked';
  if (answer.confidence === 'low') return 'model confidence is low';
  if (!answer.id_pointer || !answer.id_pointer.startsWith('/')) return 'no identifier pointer';
  let node = successSchema(doc, create);
  for (const part of answer.id_pointer.split('/').slice(1)) {
    node = deref(doc, node)?.properties?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (!node) return `${answer.id_pointer} does not exist in the ${create.key} response schema`;
  }
  const field = deref(doc, node);
  const p = deref(doc, paramSchema) ?? {};
  const ft = typeOf(field);
  const pt = typeOf(p);
  const compatible = !pt || !ft || ft === pt || (pt === 'string' && (ft === 'integer' || ft === 'number')) || (pt === 'integer' && ft === 'number');
  if (!compatible) return `type mismatch: ${answer.id_pointer} is ${ft}, the path parameter is ${pt}`;
  if (p.format && field?.format && p.format !== field.format) return `format mismatch: ${field.format} vs ${p.format}`;
  return undefined;
}

export async function proposeDependencies(
  doc: OpenApiDoc,
  ops: Operation[],
  advisor: ClaudeAdvisor,
  log: (m: string) => void,
  deps?: DepsFile,
): Promise<{ proposals: DependencyProposal[]; depsFile: DepsFile }> {
  const { candidates } = findChains(doc, ops, deps);
  const proposals: DependencyProposal[] = [];
  const depsFile: DepsFile = { scenarios: [] };

  for (const c of candidates) {
    const [createKey, ...itemKeys] = c.operations;
    const create = ops.find((o) => o.key === createKey)!;
    const items = itemKeys.map((k) => ops.find((o) => o.key === k)!).filter(Boolean);
    const param = /\{([^}]+)\}$/.exec(items[0]?.path ?? '')?.[1] ?? 'id';
    const paramSchema = items[0]?.params.find((p) => p.in === 'path' && p.name === param)?.schema;
    const base = { create: create.operationId ?? create.key, itemOperations: items.map((o) => o.key), param };

    if (!create.operationId || items.some((o) => !o.operationId)) {
      proposals.push({ ...base, status: 'not-asked', reason: 'operations without operationId cannot be written to a deps file' });
      continue;
    }
    const excerpt = {
      create_operation: { key: create.key, operationId: create.operationId, summary: create.summary ?? null, response_properties: shape(doc, successSchema(doc, create)) },
      item_operations: items.map((o) => ({ key: o.key, operationId: o.operationId, summary: o.summary ?? null })),
      path_parameter: { name: param, type: [typeOf(paramSchema) ?? 'any', paramSchema?.format].filter(Boolean).join(':') },
    };
    let answer: DependencyAnswerT | null;
    try {
      answer = await advisor.ask(SYSTEM_PROMPT, `Excerpt (JSON):\n${JSON.stringify(excerpt, null, 2)}`, DependencyAnswer);
    } catch (e) {
      proposals.push({ ...base, status: 'not-asked', reason: describeAiError(e) });
      log(`  AI: ${describeAiError(e)}`);
      break; // budget / auth problems apply to every remaining candidate
    }
    if (!answer) {
      proposals.push({ ...base, status: 'rejected', reason: 'no usable answer (declined or unparseable)' });
      continue;
    }
    const problem = verifyAnswer(doc, create, paramSchema, answer);
    if (problem) {
      proposals.push({ ...base, answer, status: 'rejected', reason: `rejected by the spec check: ${problem}` });
      continue;
    }
    const pick = (...m: string[]) => items.find((o) => m.includes(o.method))?.operationId;
    depsFile.scenarios.push({ create: create.operationId, idFrom: answer.id_pointer!, param, read: pick('get'), update: pick('patch', 'put'), delete: pick('delete') });
    proposals.push({ ...base, answer, status: 'proposed', reason: `${answer.confidence} confidence, verified against the spec: ${answer.reasoning}` });
    log(`  AI proposal: ${create.key} → ${items.map((o) => o.key).join(', ')} via ${param} = $response.body#${answer.id_pointer} (${answer.confidence})`);
  }
  return { proposals, depsFile };
}
