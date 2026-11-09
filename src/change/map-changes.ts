import { canonical, fingerprint, paramKey, pointerOf, type NormOp, type NormSpec } from './normalize.js';
import type { BlockedResult, Facet, OpenApiChange } from './types.js';

/**
 * Semantic diff of two normalized specs (docs/OPENAPI_CHANGE_TRIGGER.md: "Change kinds", "Rename detection").
 * Verdicts (`breaking`) are 'unknown' here unless the kind fixes them; the oasdiff layer fills them in.
 */

export const SCHEMA_FACETS: Facet[] = [
  'type', 'format', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'enum', 'const', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'additionalProperties',
];

export const RENAME_WEIGHTS = { operationId: 0.3, request: 0.2, response: 0.2, params: 0.15, skeleton: 0.1, security: 0.05 };
export const AUTO_LINK = 0.9;
export const REVIEW_LINK = 0.7;
export const MIN_LEAD = 0.15;

interface Pair {
  base: NormOp;
  head: NormOp;
  confidence: number;
  rule: 'external-id' | 'identity' | 'operation-id' | 'fingerprint' | 'score';
  review: boolean;
}

const nonNullType = (s: any) => {
  const t = s?.type;
  const list = t === undefined ? [] : Array.isArray(t) ? t : [t];
  const rest = list.filter((x: string) => x !== 'null');
  return rest.length === 0 ? undefined : rest.length === 1 ? rest[0] : rest;
};
const isNullable = (s: any) => (Array.isArray(s?.type) && s.type.includes('null')) || (Array.isArray(s?.enum) && s.enum.includes(null));

function similarity(a: NormOp, b: NormOp): number {
  const w = RENAME_WEIGHTS;
  let score = 0;
  if (a.operationId && a.operationId === b.operationId) score += w.operationId;
  if (fingerprint.request(a) === fingerprint.request(b)) score += w.request;
  if (fingerprint.response(a) === fingerprint.response(b)) score += w.response;
  if (fingerprint.params(a) === fingerprint.params(b)) score += w.params;
  const sa = fingerprint.skeleton(a);
  const sb = fingerprint.skeleton(b);
  const common = sa.filter((s) => sb.includes(s)).length;
  if (common && common / Math.max(sa.length, sb.length) >= 0.5) score += w.skeleton;
  if (fingerprint.security(a) === fingerprint.security(b)) score += w.security;
  return Math.round(score * 100) / 100;
}

const fullFingerprint = (o: NormOp) => [fingerprint.request(o), fingerprint.response(o), fingerprint.params(o), fingerprint.security(o)].join('|');

/** Pairs base and head operations: exact rules first, then the weighted score with thresholds and a minimum lead. */
export function pairOperations(base: NormOp[], head: NormOp[]): { pairs: Pair[]; removed: NormOp[]; added: NormOp[] } {
  const pairs: Pair[] = [];
  const freeB = new Set(base);
  const freeH = new Set(head);
  const link = (b: NormOp, h: NormOp, confidence: number, rule: Pair['rule'], review = false) => {
    pairs.push({ base: b, head: h, confidence, rule, review });
    freeB.delete(b);
    freeH.delete(h);
  };
  // 1. Same x-api-test-agent-id.
  for (const b of base) {
    if (!b.externalId) continue;
    const h = head.find((x) => freeH.has(x) && x.externalId === b.externalId);
    if (h && freeB.has(b)) link(b, h, 1, 'external-id');
  }
  // 2. Same method + normalized path.
  for (const b of [...freeB]) {
    const h = [...freeH].find((x) => x.method === b.method && x.normalizedPath === b.normalizedPath);
    if (h) link(b, h, 1, 'identity');
  }
  // 3. Unique same method + operationId, path changed.
  for (const b of [...freeB]) {
    if (!b.operationId) continue;
    const hs = [...freeH].filter((x) => x.method === b.method && x.operationId === b.operationId);
    const bs = [...freeB].filter((x) => x.method === b.method && x.operationId === b.operationId);
    if (hs.length === 1 && bs.length === 1) link(b, hs[0], 0.95, 'operation-id');
  }
  // 4. Unique same method + full contract fingerprint.
  for (const b of [...freeB]) {
    const fp = fullFingerprint(b);
    const hs = [...freeH].filter((x) => x.method === b.method && fullFingerprint(x) === fp);
    const bs = [...freeB].filter((x) => x.method === b.method && fullFingerprint(x) === fp);
    if (hs.length === 1 && bs.length === 1) link(b, hs[0], 0.9, 'fingerprint');
  }
  // 5. Weighted score (same method only), best pairs first.
  const scored: { b: NormOp; h: NormOp; score: number; lead: number }[] = [];
  for (const b of freeB) {
    const cands = [...freeH].filter((h) => h.method === b.method).map((h) => ({ h, score: similarity(b, h) })).sort((x, y) => y.score - x.score);
    if (!cands.length) continue;
    const runnerUp = Math.max(cands[1]?.score ?? 0, ...[...freeB].filter((x) => x !== b && x.method === b.method).map((x) => similarity(x, cands[0].h)));
    scored.push({ b, h: cands[0].h, score: cands[0].score, lead: Math.round((cands[0].score - runnerUp) * 100) / 100 });
  }
  scored.sort((x, y) => y.score - x.score);
  for (const s of scored) {
    if (!freeB.has(s.b) || !freeH.has(s.h) || s.score < REVIEW_LINK) continue;
    const auto = s.score >= AUTO_LINK && s.lead >= MIN_LEAD;
    link(s.b, s.h, s.score, 'score', !auto);
  }
  return { pairs, removed: [...freeB], added: [...freeH] };
}

type Emit = (c: Omit<OpenApiChange, 'operationUid' | 'operationKey' | 'breaking' | 'testRelevant'> & Partial<Pick<OpenApiChange, 'breaking' | 'testRelevant'>>) => void;

/** Facet and structure changes of one schema, recursively. */
function diffSchema(b: any, h: any, ptr: string, scope: 'request' | 'response', emit: Emit, depth = 0): void {
  if (depth > 12 || canonical(b) === canonical(h)) return;
  if (b?.$recursive || h?.$recursive) {
    if (canonical(b) !== canonical(h)) emit({ kind: scope === 'request' ? 'request-changed' : 'response-changed', pointer: ptr, scope, before: b, after: h });
    return;
  }
  const bt = nonNullType(b);
  const ht = nonNullType(h);
  if (canonical(bt) !== canonical(ht)) emit({ kind: 'schema-constraint-changed', facet: 'type', pointer: ptr, scope, before: bt, after: ht });
  if (isNullable(b) !== isNullable(h)) emit({ kind: 'schema-constraint-changed', facet: 'nullable', pointer: ptr, scope, before: isNullable(b), after: isNullable(h) });
  for (const f of SCHEMA_FACETS) {
    if (f === 'type') continue;
    if (f === 'additionalProperties' && typeof b?.[f] === 'object' && typeof h?.[f] === 'object') continue; // compared as a schema below
    const strip = (v: any) => (f === 'enum' && Array.isArray(v) ? v.filter((x) => x !== null) : v);
    if (canonical(strip(b?.[f])) !== canonical(strip(h?.[f]))) emit({ kind: 'schema-constraint-changed', facet: f, pointer: ptr, scope, before: b?.[f], after: h?.[f] });
  }
  const bp = b?.properties ?? {};
  const hp = h?.properties ?? {};
  const breq: string[] = b?.required ?? [];
  const hreq: string[] = h?.required ?? [];
  for (const name of new Set([...Object.keys(bp), ...Object.keys(hp)])) {
    const p = `${ptr}/properties/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    if (!(name in hp)) emit({ kind: scope === 'request' ? 'request-changed' : 'response-changed', pointer: p, scope, before: bp[name], after: undefined, note: `property "${name}" removed` });
    else if (!(name in bp)) emit({ kind: scope === 'request' ? 'request-changed' : 'response-changed', pointer: p, scope, before: undefined, after: hp[name], note: `property "${name}" added${hreq.includes(name) ? ' (required)' : ''}` });
    else diffSchema(bp[name], hp[name], p, scope, emit, depth + 1);
  }
  for (const name of new Set([...breq, ...hreq])) {
    if (breq.includes(name) !== hreq.includes(name) && name in bp && name in hp) {
      emit({ kind: 'schema-constraint-changed', facet: 'required', pointer: `${ptr}/properties/${name}`, scope, before: breq.includes(name), after: hreq.includes(name) });
    }
  }
  if (b?.items || h?.items) diffSchema(b?.items, h?.items, `${ptr}/items`, scope, emit, depth + 1);
  if (typeof b?.additionalProperties === 'object' && typeof h?.additionalProperties === 'object') diffSchema(b.additionalProperties, h.additionalProperties, `${ptr}/additionalProperties`, scope, emit, depth + 1);
  for (const k of ['oneOf', 'anyOf', 'allOf', 'not']) {
    if (canonical(b?.[k]) !== canonical(h?.[k])) emit({ kind: scope === 'request' ? 'request-changed' : 'response-changed', pointer: `${ptr}/${k}`, scope, before: b?.[k], after: h?.[k] });
  }
}

function diffContent(b: Record<string, any>, h: Record<string, any>, ptr: string, scope: 'request' | 'response', emit: Emit): void {
  for (const mt of new Set([...Object.keys(b), ...Object.keys(h)])) {
    const p = `${ptr}/content/${mt.replace(/\//g, '~1')}`;
    if (!(mt in h)) emit({ kind: scope === 'request' ? 'request-changed' : 'response-changed', pointer: p, scope, note: `media type ${mt} removed` });
    else if (!(mt in b)) emit({ kind: scope === 'request' ? 'request-changed' : 'response-changed', pointer: p, scope, note: `media type ${mt} added` });
    else diffSchema(b[mt], h[mt], `${p}/schema`, scope, emit);
  }
}

const unesc = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~');

/** Whether the node that holds an example (pointer relative to the operation) exists in this operation. */
function exampleHolderExists(op: NormOp, ptr: string): boolean {
  const parts = ptr.split('/').slice(1).map(unesc);
  parts.pop(); // example | examples | default
  let node: any;
  if (parts[0] === 'parameters') {
    const p = op.params.find((x) => paramKey(op.path, x) === parts[1]);
    if (!p) return false;
    node = p.schema;
    parts.splice(0, 3); // parameters, key, schema
  } else if (parts[0] === 'requestBody') {
    node = op.requestBody?.content?.[parts[2]];
    if (node === undefined) return false;
    parts.splice(0, 4); // requestBody, content, media type, schema
  } else if (parts[0] === 'responses') {
    node = op.responses[parts[1]]?.content?.[parts[3]];
    if (node === undefined) return false;
    parts.splice(0, 5); // responses, status, content, media type, schema
  } else return true;
  for (const seg of parts) {
    if (!node || typeof node !== 'object') return false;
    node = node[seg];
  }
  return node !== undefined;
}

/** Changes inside a paired operation (the head side's pointers). */
function diffOperation(b: NormOp, h: NormOp, emit: Emit): void {
  if (b.operationId !== h.operationId && b.method === h.method && b.normalizedPath === h.normalizedPath) {
    emit({ kind: 'operationId-renamed', pointer: `${h.pointer}/operationId`, before: b.operationId, after: h.operationId, breaking: 'no', testRelevant: true, note: 'API object method names follow the operationId' });
  }
  // Path parameters are matched by position (their names are not identity); others by in + name.
  const bPath = b.params.filter((p) => p.in === 'path');
  const hPath = h.params.filter((p) => p.in === 'path');
  const bNames = (b.path.match(/\{([^}]*)\}/g) ?? []).map((s) => s.slice(1, -1));
  const hNames = (h.path.match(/\{([^}]*)\}/g) ?? []).map((s) => s.slice(1, -1));
  if (b.normalizedPath === h.normalizedPath && canonical(bNames) !== canonical(hNames)) {
    emit({ kind: 'parameter-renamed', pointer: `${h.pointer}/parameters`, scope: 'request', before: bNames, after: hNames, breaking: 'no', testRelevant: true, note: 'zero contract change; generated method arguments are renamed' });
  }
  const pairsOfParams: [any, any, string][] = [];
  bNames.forEach((n, i) => {
    const bp = bPath.find((p) => p.name === n);
    const hp = hPath.find((p) => p.name === hNames[i]);
    if (bp && hp) pairsOfParams.push([bp, hp, `path:${hNames[i]}`]);
  });
  const other = (list: NormOp['params']) => new Map(list.filter((p) => p.in !== 'path').map((p) => [`${p.in}:${p.name}`, p]));
  const bo = other(b.params);
  const ho = other(h.params);
  for (const k of new Set([...bo.keys(), ...ho.keys()])) {
    const bp = bo.get(k);
    const hp = ho.get(k);
    const ptr = `${h.pointer}/parameters/${k}`;
    if (!hp) emit({ kind: 'parameter-changed', pointer: ptr, scope: 'request', before: bp, after: undefined, note: `parameter ${k} removed` });
    else if (!bp) emit({ kind: 'parameter-changed', pointer: ptr, scope: 'request', before: undefined, after: hp, note: `parameter ${k} added${hp.required ? ' (required)' : ''}` });
    else pairsOfParams.push([bp, hp, k]);
  }
  for (const [bp, hp, k] of pairsOfParams) {
    const ptr = `${h.pointer}/parameters/${k}`;
    if (bp.required !== hp.required) emit({ kind: 'schema-constraint-changed', facet: 'required', pointer: ptr, scope: 'request', before: bp.required, after: hp.required });
    diffSchema(bp.schema, hp.schema, `${ptr}/schema`, 'request', emit);
  }
  // Request body.
  const rb = b.requestBody;
  const rh = h.requestBody;
  const bodyPtr = `${h.pointer}/requestBody`;
  if (!rb && rh) emit({ kind: 'request-changed', pointer: bodyPtr, scope: 'request', note: `request body added${rh.required ? ' (required)' : ''}` });
  else if (rb && !rh) emit({ kind: 'request-changed', pointer: bodyPtr, scope: 'request', note: 'request body removed' });
  else if (rb && rh) {
    if (rb.required !== rh.required) emit({ kind: 'schema-constraint-changed', facet: 'required', pointer: bodyPtr, scope: 'request', before: rb.required, after: rh.required });
    diffContent(rb.content, rh.content, bodyPtr, 'request', emit);
  }
  // Responses.
  for (const status of new Set([...Object.keys(b.responses), ...Object.keys(h.responses)])) {
    const ptr = `${h.pointer}/responses/${status}`;
    if (!(status in h.responses)) emit({ kind: 'response-changed', pointer: ptr, scope: 'response', note: `response ${status} removed` });
    else if (!(status in b.responses)) emit({ kind: 'response-changed', pointer: ptr, scope: 'response', note: `response ${status} added` });
    else diffContent(b.responses[status].content, h.responses[status].content, ptr, 'response', emit);
  }
  if (canonical(b.security) !== canonical(h.security)) emit({ kind: 'request-changed', pointer: `${h.pointer}/security`, scope: 'request', before: b.security, after: h.security, note: 'security requirements changed' });
  // Examples / defaults: the generator uses them as payload sources. An example inside a parameter, response,
  // media type or property that exists on one side only is part of that (already reported) change.
  for (const p of new Set([...Object.keys(b.examples), ...Object.keys(h.examples)])) {
    if (!exampleHolderExists(b, p) || !exampleHolderExists(h, p)) continue;
    if (canonical(b.examples[p]) !== canonical(h.examples[p])) {
      emit({ kind: 'example-changed', pointer: `${h.pointer}${p}`, scope: /^\/responses\//.test(p) ? 'response' : 'request', before: b.examples[p], after: h.examples[p], breaking: 'no', testRelevant: true });
    }
  }
}

/** All changes between two normalized specs, plus BLOCKED results the comparison itself finds. */
export function mapChanges(base: NormSpec, head: NormSpec): { changes: OpenApiChange[]; blocked: BlockedResult[] } {
  const blocked: BlockedResult[] = [...base.blocked, ...head.blocked];
  // Duplicate x-api-test-agent-id: those operations get no automatic identity at all.
  const excluded = new Set<NormOp>();
  for (const [side, spec] of [['base', base], ['head', head]] as const) {
    const byId = new Map<string, NormOp[]>();
    for (const o of spec.ops) if (o.externalId) byId.set(o.externalId, [...(byId.get(o.externalId) ?? []), o]);
    for (const [id, list] of byId) {
      if (list.length < 2) continue;
      list.forEach((o) => excluded.add(o));
      blocked.push({ code: 'DUPLICATE_API_TEST_AGENT_ID', pointers: list.map((o) => `${o.pointer}/x-api-test-agent-id`), reason: `x-api-test-agent-id "${id}" is used by ${list.map((o) => o.key).join(' and ')} in the ${side} spec; it must be unique. Fix it in the spec.` });
    }
  }
  const { pairs, removed, added } = pairOperations(base.ops.filter((o) => !excluded.has(o)), head.ops.filter((o) => !excluded.has(o)));
  const changes: OpenApiChange[] = [];
  for (const o of removed) changes.push({ kind: 'operation-removed', operationUid: o.uid, operationKey: o.key, pointer: o.pointer, breaking: 'unknown', testRelevant: true });
  for (const o of added) changes.push({ kind: 'operation-added', operationUid: o.uid, operationKey: o.key, pointer: o.pointer, breaking: 'no', testRelevant: true });
  for (const p of pairs) {
    // A linked move keeps the base operationUid.
    const uid = p.base.uid;
    const emit: Emit = (c) => changes.push({ breaking: 'unknown', testRelevant: true, ...c, operationUid: uid, operationKey: p.head.key });
    if (p.rule !== 'identity' && p.rule !== 'external-id') {
      emit({ kind: 'operation-moved', pointer: p.head.pointer, before: p.base.key, after: p.head.key, confidence: p.confidence, ...(p.review ? { review: true } : {}), note: `linked by ${p.rule}${p.review ? '; needs review' : ''}` });
    } else if (p.rule === 'external-id' && (p.base.method !== p.head.method || p.base.normalizedPath !== p.head.normalizedPath)) {
      emit({ kind: 'operation-moved', pointer: p.head.pointer, before: p.base.key, after: p.head.key, confidence: 1, note: 'same x-api-test-agent-id' });
    }
    diffOperation(p.base, p.head, emit);
  }
  if (canonical(base.servers) !== canonical(head.servers)) {
    changes.push({ kind: 'servers-changed', operationUid: '', operationKey: 'servers', pointer: '/servers', before: base.servers, after: head.servers, breaking: 'no', testRelevant: false, note: 'reported only; never regenerates cases' });
  }
  return { changes, blocked };
}

export { pointerOf };
