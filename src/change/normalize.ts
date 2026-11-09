import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { ConfigError, type BlockedResult } from './types.js';

/**
 * Normalized API model for the semantic diff (docs/OPENAPI_CHANGE_TRIGGER.md, "Normalization").
 * Formatting, key order, $ref layout, inline ↔ component, equivalent allOf and 3.0 nullable ↔ 3.1 type-null
 * produce the same model, so they produce no changes.
 */

export const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query'];

export interface NormParam {
  in: string;
  name: string;
  required: boolean;
  schema: any;
  example?: unknown;
}

export interface NormOp {
  uid: string;
  method: string; // uppercase
  path: string;
  normalizedPath: string;
  key: string; // "GET /brands/{brandId}"
  operationId?: string;
  externalId?: string; // x-api-test-agent-id
  pointer: string; // JSON pointer of the operation in its document
  params: NormParam[];
  requestBody?: { required: boolean; content: Record<string, any> };
  responses: Record<string, { content: Record<string, any> }>;
  security: unknown;
  /** example / default values by JSON pointer inside the operation (parameters, media types, schemas). */
  examples: Record<string, unknown>;
}

export interface NormSpec {
  version: string;
  ops: NormOp[];
  servers: unknown;
  externalRefs: string[]; // $refs that point outside the document
  blocked: BlockedResult[];
  raw: any;
}

const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
export const pointerOf = (...parts: string[]) => '/' + parts.map(esc).join('/');

/** `/brands/{id}` → `/brands/{}`: parameter names are not part of identity; everything else is kept as written. */
export const normalizePath = (path: string) => path.replace(/\{[^}]*\}/g, '{}');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** RFC 4648 base32, uppercase, no padding. */
export function base32(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** operationUid = "op_" + base32(sha256(UPPERCASE_METHOD + " " + normalizedPath))[0:length] (12 unless a collision needs more). */
export function operationUid(method: string, normalizedPath: string, length = 12): string {
  return 'op_' + base32(createHash('sha256').update(`${method.toUpperCase()} ${normalizedPath}`).digest()).slice(0, length);
}

/** Sorted-key JSON: equal for semantically equal values whatever the key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .filter((k) => (v as any)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function resolveLocal(doc: any, ref: string): any {
  const parts = ref.slice(2).split('/').map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = doc;
  for (const p of parts) {
    if (node === undefined || node === null) return undefined;
    node = node[p];
  }
  return node;
}

/** Inlines local $refs (cycles become { $recursive: <ref> }); remote / file $refs are collected and left in place. */
function deref(doc: any, node: any, external: Set<string>, stack: string[] = []): any {
  if (Array.isArray(node)) return node.map((n) => deref(doc, n, external, stack));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const ref: string = node.$ref;
    if (!ref.startsWith('#/')) {
      external.add(ref);
      return node;
    }
    if (stack.includes(ref)) return { $recursive: ref };
    const target = resolveLocal(doc, ref);
    if (target === undefined) return { $unresolved: ref };
    const { $ref: _r, ...siblings } = node;
    const resolved = deref(doc, target, external, [...stack, ref]);
    return Object.keys(siblings).length ? { ...resolved, ...deref(doc, siblings, external, stack) } : resolved;
  }
  const out: any = {};
  for (const [k, v] of Object.entries(node)) out[k] = deref(doc, v, external, stack);
  return out;
}

const ANNOTATIONS = new Set(['description', 'title', 'summary', 'externalDocs', '$comment', 'xml']);
const EXAMPLES = new Set(['example', 'examples', 'default']);

/** Canonical schema: annotations dropped, nullable → type-null, simple allOf merged, type arrays sorted. */
export function normalizeSchema(s: any, keepExamples = false): any {
  if (Array.isArray(s)) return s.map((x) => normalizeSchema(x, keepExamples));
  if (!s || typeof s !== 'object') return s;
  let out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (ANNOTATIONS.has(k)) continue;
    if (!keepExamples && EXAMPLES.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') out.properties = Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, normalizeSchema(ps, keepExamples)]));
    else if (k === 'example' || k === 'examples' || k === 'default' || k === 'enum' || k === 'const') out[k] = v;
    else out[k] = normalizeSchema(v, keepExamples);
  }
  // 3.0 nullable: true ≡ 3.1 type: [x, 'null']
  if (out.nullable === true) {
    const types = out.type === undefined ? [] : Array.isArray(out.type) ? out.type : [out.type];
    if (types.length && !types.includes('null')) out.type = [...types, 'null'];
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
  }
  delete out.nullable;
  if (Array.isArray(out.type)) {
    const t = [...new Set(out.type as string[])].sort();
    out.type = t.length === 1 ? t[0] : t;
  }
  if (out.required && Array.isArray(out.required)) out.required = [...new Set(out.required as string[])].sort();
  // Equivalent allOf expansion: object parts without conflicts merge into one schema.
  if (Array.isArray(out.allOf) && out.allOf.every((p: any) => p && typeof p === 'object' && !p.$recursive)) {
    const { allOf, ...rest } = out;
    const merged: any = { ...rest };
    let ok = true;
    for (const part of allOf) {
      for (const [k, v] of Object.entries<any>(part)) {
        if (k === 'properties') merged.properties = { ...(merged.properties ?? {}), ...v };
        else if (k === 'required') merged.required = [...new Set([...(merged.required ?? []), ...v])].sort();
        else if (merged[k] === undefined) merged[k] = v;
        else if (canonical(merged[k]) !== canonical(v)) ok = false;
      }
    }
    if (ok) out = merged;
  }
  if (out.properties && out.type === undefined) out.type = 'object';
  return out;
}

const MEDIA = (content: any, keepExamples: boolean) =>
  Object.fromEntries(Object.entries<any>(content ?? {}).map(([mt, m]) => [mt.split(';')[0].trim().toLowerCase(), normalizeSchema(m?.schema ?? {}, keepExamples)]));

/** Parses and normalizes one spec. Schemas are compared without example / default; those are collected in `examples`. */
export function normalizeSpec(raw: string, label: string): NormSpec {
  const keepExamples = false;
  let doc: any;
  try {
    doc = parseYaml(raw);
  } catch (e: any) {
    throw new ConfigError(`${label} is not valid YAML / JSON: ${e?.message ?? e}`);
  }
  if (!doc || typeof doc !== 'object' || !/^3\.(0|1|2)\./.test(String(doc.openapi ?? ''))) {
    throw new ConfigError(`${label} is not an OpenAPI 3.x document (openapi: ${doc?.openapi ?? 'missing'}).`);
  }
  const external = new Set<string>();
  const ops: NormOp[] = [];
  const blocked: BlockedResult[] = [];
  for (const [path, rawItem] of Object.entries<any>(doc.paths ?? {})) {
    const item = deref(doc, rawItem, external);
    const shared: any[] = Array.isArray(item?.parameters) ? item.parameters : [];
    for (const m of METHODS) {
      const op = item?.[m];
      if (!op || typeof op !== 'object') continue;
      const own: any[] = Array.isArray(op.parameters) ? op.parameters : [];
      const byKey = new Map<string, any>();
      for (const p of [...shared, ...own]) if (p?.name && p?.in) byKey.set(`${p.in}:${p.name}`, p);
      const params: NormParam[] = [...byKey.values()].map((p) => ({
        in: p.in,
        name: p.name,
        required: p.in === 'path' ? true : !!p.required,
        schema: normalizeSchema(p.schema ?? {}, keepExamples),
        ...(keepExamples && p.example !== undefined ? { example: p.example } : {}),
      }));
      const method = m.toUpperCase();
      const normalizedPath = normalizePath(path);
      const responses: NormOp['responses'] = {};
      for (const [status, r] of Object.entries<any>(op.responses ?? {})) responses[String(status).toUpperCase()] = { content: MEDIA(r?.content, keepExamples) };
      const xid = op['x-api-test-agent-id'];
      ops.push({
        uid: '',
        method,
        path,
        normalizedPath,
        key: `${method} ${path}`,
        operationId: op.operationId,
        externalId: typeof xid === 'string' && xid.trim() ? xid.trim() : undefined,
        pointer: pointerOf('paths', path, m),
        params,
        requestBody: op.requestBody ? { required: !!op.requestBody.required, content: MEDIA(op.requestBody.content, keepExamples) } : undefined,
        responses,
        security: op.security ?? doc.security ?? null,
        // Collected from the normalized schemas, so an equivalent restructuring (allOf, $ref) does not move them.
        examples: collectExamples({
          parameters: Object.fromEntries([...byKey.values()].map((p) => [paramKey(path, p), { example: p.example, examples: p.examples, schema: normalizeSchema(p.schema ?? {}, true) }])),
          requestBody: op.requestBody ? { content: mediaExamples(op.requestBody.content) } : undefined,
          responses: Object.fromEntries(Object.entries<any>(op.responses ?? {}).map(([s, r]) => [String(s).toUpperCase(), { content: mediaExamples(r?.content) }])),
        }),
      });
    }
  }
  // Identity: two operations with the same method + normalized path (e.g. /a/{x} and /a/{y}) cannot be told apart.
  const seen = new Map<string, NormOp>();
  for (const o of ops) {
    const k = `${o.method} ${o.normalizedPath}`;
    const prev = seen.get(k);
    if (prev) blocked.push({ code: 'DUPLICATE_OPERATION_IDENTITY', pointers: [prev.pointer, o.pointer], reason: `${prev.key} and ${o.key} have the same method and normalized path ${o.normalizedPath} in ${label}.` });
    else seen.set(k, o);
  }
  assignUids(ops);
  return { version: String(doc.openapi), ops, servers: doc.servers ?? null, externalRefs: [...external], blocked, raw: doc };
}

/** Parameter key in example pointers: path parameters by position (their names are not identity), others by in + name. */
export function paramKey(path: string, p: { in: string; name: string }): string {
  if (p.in !== 'path') return `${p.in}:${p.name}`;
  const names = (path.match(/\{([^}]*)\}/g) ?? []).map((s) => s.slice(1, -1));
  return `path:#${names.indexOf(p.name)}`;
}

const mediaExamples = (content: any) =>
  Object.fromEntries(
    Object.entries<any>(content ?? {}).map(([mt, m]) => [mt.split(';')[0].trim().toLowerCase(), { example: m?.example, examples: m?.examples, schema: normalizeSchema(m?.schema ?? {}, true) }]),
  );

/** example / examples / default by pointer; a property *named* "default" is a property, not a value. */
function collectExamples(node: any, ptr = "", inProps = false, out: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(node)) {
    node.forEach((n, i) => collectExamples(n, `${ptr}/${i}`, false, out));
    return out;
  }
  if (!node || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node)) {
    if (v === undefined) continue;
    const p = `${ptr}/${esc(k)}`;
    if (inProps) collectExamples(v, p, false, out);
    else if (EXAMPLES.has(k)) out[p] = v;
    else if (!ANNOTATIONS.has(k)) collectExamples(v, p, k === "properties", out);
  }
  return out;
}

/** Deterministic UIDs; a truncated-hash collision lengthens the hash (never an order-dependent suffix). */
function assignUids(ops: NormOp[]): void {
  for (let length = 12; length <= 52; length += 4) {
    const uids = ops.map((o) => operationUid(o.method, o.normalizedPath, length));
    const byUid = new Map<string, string>();
    let collision = false;
    uids.forEach((u, i) => {
      const id = `${ops[i].method} ${ops[i].normalizedPath}`;
      if (byUid.has(u) && byUid.get(u) !== id) collision = true;
      byUid.set(u, id);
    });
    if (!collision) {
      ops.forEach((o, i) => (o.uid = uids[i]));
      return;
    }
  }
  throw new Error('operationUid collision that lengthening the hash cannot resolve.');
}

/** Fingerprints used by rename detection (examples and annotations are not part of them). */
export const fingerprint = {
  request: (o: NormOp) => canonical(o.requestBody ?? null),
  response: (o: NormOp) => canonical(o.responses),
  params: (o: NormOp) => canonical(o.params.map((p) => ({ in: p.in, name: p.in === 'path' ? '{}' : p.name, required: p.required, schema: p.schema })).sort((a, b) => canonical(a).localeCompare(canonical(b)))),
  security: (o: NormOp) => canonical(o.security),
  skeleton: (o: NormOp) => o.normalizedPath.split('/').filter((s) => s && s !== '{}'),
};
