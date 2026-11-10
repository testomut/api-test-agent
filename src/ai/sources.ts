import type { Operation } from '../types.js';
import { resolvePointer, type OpenApiDoc } from '../spec/loader.js';
import { operationPointer } from '../spec/catalog.js';
import { AiRunner, describeAiError } from './runner.js';

/**
 * AI step for READ-ONLY resource sources: where an existing value of a path parameter can be read, e.g.
 * "brandId of GET /brands/{brandId} is /0/id of GET /brands". Asked only for safe operations whose positive test is
 * blocked by an unknown path value. The model sees operation keys, summaries, field names and types - never data.
 * Every answer is checked against the spec (the source is a safe operation of the spec, the pointer exists in its
 * response schema, the field type fits the parameter) before it is used; a test built from it only reads
 * (list → read by id) and is marked "AI-proposed, unreviewed". Reviewed sources live in the deps file:
 *   "sources": [{ "operationId": "getBrand", "param": "brandId", "from": "getBrands", "pointer": "/0/id" }]
 */

export interface SourceConfig {
  operationId: string;
  param: string;
  from: string;
  pointer: string;
}

export interface ResolvedSource {
  op: Operation;
  param: string;
  from: Operation;
  pointer: string;
  /** Proposed by the AI step this run (not reviewed); false for a deps-file entry. */
  ai: boolean;
  reason: string;
}

export interface SourceAnswerT {
  from: string | null;
  pointer: string | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export const SOURCE_SCHEMA = {
  type: 'object',
  properties: {
    from: { type: ['string', 'null'], description: 'operationId of the candidate list operation whose response holds existing values of the parameter; null if none fits' },
    pointer: { type: ['string', 'null'], description: 'JSON pointer to one value in that response, with 0 for the first array element, e.g. "/data/0/id"; null if none fits' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'string', description: 'one or two sentences, citing only names from the excerpt' },
  },
  required: ['from', 'pointer', 'confidence', 'reasoning'],
  additionalProperties: false,
};

export const SOURCE_PROMPT = `You review REST API specifications for an API test generator.
You get one read operation with a path parameter and candidate list operations with the fields of their response elements.
Pick the candidate whose elements are the resources the path parameter identifies, and the field that holds the identifier.
Rules:
- Use only names and types that appear in the excerpt. Never invent operations or fields.
- If no candidate clearly lists those resources, or the identifier field is not clear, answer from=null or confidence "low".
- pointer is a JSON pointer into the candidate's response body, using 0 for the first array element, e.g. "/0/id" or "/data/0/id".`;

const deref = (doc: OpenApiDoc, s: any, depth = 0): any => (s?.$ref && depth < 20 ? deref(doc, resolvePointer(doc, s.$ref.slice(1)).node, depth + 1) : s);
const typeOf = (s: any): string | undefined => (Array.isArray(s?.type) ? s.type.find((t: string) => t !== 'null') : s?.type ?? (s?.properties ? 'object' : s?.items ? 'array' : undefined));

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

/** Arrays of objects in a response: pointer to the array ("" = the body) and the element's field names / types. */
function listings(doc: OpenApiDoc, schema: any): { items: string; fields: Record<string, string> }[] {
  const out: { items: string; fields: Record<string, string> }[] = [];
  const fieldsOf = (el: any) => Object.fromEntries(Object.entries<any>(deref(doc, el)?.properties ?? {}).map(([k, v]) => [k, [typeOf(deref(doc, v)) ?? 'any', deref(doc, v)?.format].filter(Boolean).join(':')]));
  const s = deref(doc, schema);
  if (typeOf(s) === 'array' && typeOf(deref(doc, s.items)) === 'object') out.push({ items: '', fields: fieldsOf(s.items) });
  for (const [k, v] of Object.entries<any>(s?.properties ?? {})) {
    const p = deref(doc, v);
    if (typeOf(p) === 'array' && typeOf(deref(doc, p.items)) === 'object') out.push({ items: `/${k}`, fields: fieldsOf(p.items) });
  }
  return out;
}

/** Safe operations without unknown path / required query values whose response lists objects: possible sources. */
export function sourceCandidates(doc: OpenApiDoc, ops: Operation[]): { op: Operation; listings: { items: string; fields: Record<string, string> }[] }[] {
  return ops
    .filter((o) => o.method === 'get' && o.operationId && !o.deprecated)
    .filter((o) => !o.params.some((p) => (p.in === 'path' || p.required) && p.knownValue === undefined))
    .map((o) => ({ op: o, listings: listings(doc, successSchema(doc, o)) }))
    .filter((c) => c.listings.length);
}

/** Deterministic check of a source (AI answer or deps entry) against the spec. */
export function verifySource(doc: OpenApiDoc, ops: Operation[], target: Operation, param: string, from: string | null, pointer: string | null): { from?: Operation; problem?: string } {
  const p = target.params.find((x) => x.in === 'path' && x.name === param);
  if (!p) return { problem: `${target.key} has no path parameter "${param}"` };
  const src = ops.find((o) => o.operationId === from);
  if (!src) return { problem: `operation "${from}" is not in the spec` };
  if (!sourceCandidates(doc, ops).some((c) => c.op === src)) return { problem: `${src.key} is not a safe list operation that can be called as is` };
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return { problem: 'the pointer is not a JSON pointer such as "/0/id"' };
  let node = successSchema(doc, src);
  let throughElement = false;
  for (const raw of pointer.split('/').slice(1)) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = deref(doc, node);
    if (/^\d+$/.test(seg) && typeOf(node) === 'array') {
      node = node.items;
      throughElement = true;
    } else node = node?.properties?.[seg];
    if (!node) return { problem: `${pointer} does not exist in the ${src.key} response schema` };
  }
  // A value of an existing record: the pointer goes through a list element, not to a field of the response itself.
  if (!throughElement) return { problem: `${pointer} is not inside a list element of the ${src.key} response` };
  const field = deref(doc, node);
  const ft = typeOf(field);
  const pt = typeOf(p.schema);
  // An identifier: the same type, or an integer id in a string path parameter (never a decimal number).
  const compatible = !pt || !ft || ft === pt || (pt === 'string' && ft === 'integer');
  if (!compatible) return { problem: `type mismatch: ${pointer} is ${ft}, the path parameter is ${pt}` };
  const pf = (p.schema as any)?.format;
  if (pf && field?.format && pf !== field.format) return { problem: `format mismatch: ${field.format} vs ${pf}` };
  return { from: src };
}

/** Reviewed deps-file sources, checked against the spec; problems are returned, never used. */
export function reviewedSources(doc: OpenApiDoc, ops: Operation[], configs: SourceConfig[] | undefined): { sources: ResolvedSource[]; errors: { operationId: string; reason: string }[] } {
  const sources: ResolvedSource[] = [];
  const errors: { operationId: string; reason: string }[] = [];
  for (const c of configs ?? []) {
    const op = ops.find((o) => o.operationId === c?.operationId);
    if (!op) {
      errors.push({ operationId: String(c?.operationId), reason: `sources: operation "${c?.operationId}" is not in the spec` });
      continue;
    }
    const v = verifySource(doc, ops, op, c.param, c.from, c.pointer);
    if (v.problem) errors.push({ operationId: c.operationId, reason: `sources: ${v.problem}` });
    else sources.push({ op, param: c.param, from: v.from!, pointer: c.pointer, ai: false, reason: 'deps file (reviewed)' });
  }
  return { sources, errors };
}

/** Operations a source would unblock: safe, not deprecated, exactly one path parameter without a real value. */
export function sourceTargets(ops: Operation[], covered: (op: Operation) => boolean): { op: Operation; param: string }[] {
  const out: { op: Operation; param: string }[] = [];
  for (const op of ops.filter((o) => o.method === 'get' && o.operationId && !o.deprecated && !covered(o))) {
    const unknown = op.params.filter((p) => p.in === 'path' && (p.knownValue === undefined || p.knownSource === 'example'));
    if (unknown.length === 1 && !op.params.some((p) => p.in !== 'path' && p.required && p.knownValue === undefined)) out.push({ op, param: unknown[0].name });
  }
  return out;
}

export interface SourceProposal {
  operation: string;
  param: string;
  answer?: SourceAnswerT;
  status: 'used' | 'rejected' | 'not-asked' | 'cached';
  reason: string;
}

/** Cache of AI answers in the suite (regeneration stays deterministic): key = operation, parameter and candidates. */
export type SourceCache = Record<string, SourceAnswerT>;

export async function proposeSources(
  doc: OpenApiDoc,
  ops: Operation[],
  targets: { op: Operation; param: string }[],
  advisor: AiRunner | undefined,
  cache: SourceCache,
  log: (m: string) => void,
): Promise<{ sources: ResolvedSource[]; proposals: SourceProposal[]; cache: SourceCache; deps: SourceConfig[] }> {
  const candidates = sourceCandidates(doc, ops);
  const sources: ResolvedSource[] = [];
  const proposals: SourceProposal[] = [];
  const deps: SourceConfig[] = [];
  const next: SourceCache = {};
  let aiDown = !advisor;
  for (const t of targets) {
    const param = t.op.params.find((p) => p.in === 'path' && p.name === t.param)!;
    const usable = candidates.filter((c) => c.op !== t.op);
    const key = `${t.op.operationId}#${t.param}#${usable.map((c) => c.op.operationId).sort().join(',')}`;
    let answer: SourceAnswerT | null | undefined = cache[key];
    let status: SourceProposal['status'] = 'cached';
    if (!answer) {
      if (aiDown || !usable.length) {
        proposals.push({ operation: t.op.key, param: t.param, status: 'not-asked', reason: !usable.length ? 'no safe list operation to read existing values from' : 'AI not available' });
        continue;
      }
      const excerpt = {
        read_operation: { key: t.op.key, operationId: t.op.operationId, summary: t.op.summary ?? null, path_parameter: { name: t.param, type: [typeOf(param.schema) ?? 'any', (param.schema as any)?.format].filter(Boolean).join(':') } },
        candidates: usable.map((c) => ({ operationId: c.op.operationId, key: c.op.key, summary: c.op.summary ?? null, listings: c.listings.map((l) => ({ array_at: l.items || '(the body)', element_fields: l.fields })) })),
      };
      try {
        answer = await advisor!.ask<SourceAnswerT>(SOURCE_PROMPT, `Excerpt (JSON):\n${JSON.stringify(excerpt, null, 2)}\n\nAnswer with the JSON object only.`, SOURCE_SCHEMA);
        status = 'used';
      } catch (e) {
        log(`  AI: ${describeAiError(e)}: the remaining operations are generated without AI`);
        aiDown = true;
        proposals.push({ operation: t.op.key, param: t.param, status: 'not-asked', reason: describeAiError(e) });
        continue;
      }
      if (!answer) {
        proposals.push({ operation: t.op.key, param: t.param, status: 'rejected', reason: 'no usable answer (declined or unparseable)' });
        continue;
      }
    }
    next[key] = answer;
    if (!answer.from || !answer.pointer || answer.confidence === 'low') {
      proposals.push({ operation: t.op.key, param: t.param, answer, status: 'rejected', reason: answer.confidence === 'low' ? 'model confidence is low' : 'model found no source' });
      continue;
    }
    const v = verifySource(doc, ops, t.op, t.param, answer.from, answer.pointer);
    if (v.problem) {
      proposals.push({ operation: t.op.key, param: t.param, answer, status: 'rejected', reason: `rejected by the spec check: ${v.problem}` });
      continue;
    }
    sources.push({ op: t.op, param: t.param, from: v.from!, pointer: answer.pointer, ai: true, reason: `${answer.confidence} confidence: ${answer.reasoning}` });
    deps.push({ operationId: t.op.operationId!, param: t.param, from: answer.from, pointer: answer.pointer });
    proposals.push({ operation: t.op.key, param: t.param, answer, status, reason: `${answer.confidence} confidence, verified against the spec: ${answer.reasoning}` });
    log(`  AI source: ${t.op.key} ${t.param} ← ${v.from!.key} #${answer.pointer} (${answer.confidence}${status === 'cached' ? ', cached' : ''})`);
  }
  return { sources, proposals, cache: next, deps };
}
