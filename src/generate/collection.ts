import { resolvePointer, type OpenApiDoc } from '../spec/loader.js';
import type { Operation } from '../types.js';
import type { CoverageGap } from './body-cases.js';

/**
 * Collection endpoints (GET lists): how a reviewed deps file describes them, and the strict check of that
 * description against the spec. Nothing here is inferred from endpoint names.
 *
 * "collection": {
 *   "operationId": "listItems",
 *   "items": "/items",                    JSON pointer to the array in the response ("" = the body is the array)
 *   "id": "/id",                          element field holding the identifier the create returns
 *   "fields": { "/name": "exact", "/price": "tolerance:0.001", "/createdAt": "ignore" },   persistence confirmed
 *   "unique": ["/id"],                    uniqueness the API guarantees
 *   "total": "/total",                    JSON pointer to the total count in the response (consistent across pages)
 *   "filters": [{ "param": "tag", "field": "/tags", "match": "contains" }],   equals | contains (array) | search
 *                                         (search: the string field contains the value, ignoring case)
 *   "sorts": [{ "param": "sort", "value": "price", "field": "/price", "order": "asc" }],
 *   "page": { "style": "offset", "offsetParam": "offset", "limitParam": "limit", "maxPages": 20 },
 *           or { "style": "page", "pageParam": "page", "sizeParam": "per_page" } or, when the API fixes the size,
 *           { "style": "page", "pageParam": "page", "size": 9 }   (no size parameter: the reviewed fixed page size)
 *           or { "style": "page", "pageParam": "page", "sizeParam": "per_page" } or, when the API fixes the size,
 *           { "style": "page", "pageParam": "page", "size": 9 }   (no size parameter: the reviewed fixed page size)
 *   "consistency": { "pollTimeoutMs": 5000, "pollIntervalMs": 250 },   eventual consistency, bounded polling
 *   "deletedDisappears": true,           a deleted resource is guaranteed to leave the list
 *   "strategy": "read-only"              never create records for these checks (shared environments), even with a
 *                                        confirmed create; the checks then run on existing data (strategy C)
 * }
 */

export type FieldPolicy = 'exact' | 'schema' | 'ignore' | `tolerance:${number}`;

export interface CollectionConfig {
  operationId: string;
  items: string;
  id: string;
  fields?: Record<string, string>;
  unique?: string[];
  filters?: { param: string; field: string; match: 'equals' | 'contains' | 'search' }[];
  total?: string;
  sorts?: { param: string; value: string; field: string; order: 'asc' | 'desc' }[];
  page?: { style: 'offset'; offsetParam: string; limitParam: string; maxPages?: number } | { style: 'page'; pageParam: string; sizeParam?: string; size?: number; firstPage?: number; maxPages?: number };
  consistency?: { pollTimeoutMs: number; pollIntervalMs: number };
  deletedDisappears?: boolean;
  strategy?: 'read-only';
}

export interface ResolvedCollection extends CollectionConfig {
  op: Operation;
  maxPages: number;
  /** Schema of one element (for checks that need a type). */
  itemSchema: any;
}

const deref = (doc: OpenApiDoc, s: any, depth = 0): any => (s?.$ref && depth < 20 ? deref(doc, resolvePointer(doc, s.$ref.slice(1)).node, depth + 1) : s);
const typesOf = (s: any): string[] => (s?.type === undefined ? (s?.properties ? ['object'] : s?.items ? ['array'] : []) : Array.isArray(s.type) ? s.type : [s.type]);

/** Follows a JSON pointer through a schema (properties, array items for "*"), $refs and allOf resolved. */
export function schemaAt(doc: OpenApiDoc, schema: any, pointer: string): any {
  let node = deref(doc, schema);
  for (const raw of pointer.split('/').slice(1)) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node) return undefined;
    if (Array.isArray(node.allOf)) node = Object.assign({}, ...node.allOf.map((p: any) => deref(doc, p)), { properties: Object.assign({}, ...node.allOf.map((p: any) => deref(doc, p)?.properties ?? {}), node.properties ?? {}) });
    node = deref(doc, seg === '*' ? node.items : node.properties?.[seg]);
  }
  return node;
}

/** The array a collection response holds: the body itself, or its single array property. Never guessed by name. */
export function detectItems(doc: OpenApiDoc, op: Operation): string | undefined {
  const ok = op.responses.find((r) => /^2\d\d$/.test(r.status));
  const schema = ok ? resolvePointer(doc, `/paths/${op.path.replace(/~/g, '~0').replace(/\//g, '~1')}/${op.method}/responses/${ok.status}/content/application~1json/schema`).node : undefined;
  const s = deref(doc, schema);
  if (!s) return undefined;
  if (typesOf(s).includes('array')) return '';
  const arrays = Object.entries<any>(s.properties ?? {}).filter(([, p]) => typesOf(deref(doc, p)).includes('array'));
  return arrays.length === 1 ? `/${arrays[0][0]}` : undefined;
}

export function resolveCollection(doc: OpenApiDoc, ops: Operation[], cfg: CollectionConfig): { collection?: ResolvedCollection; errors: string[] } {
  const errors: string[] = [];
  const op = ops.find((o) => o.operationId === cfg?.operationId);
  if (!op) return { errors: [`collection: operation "${cfg?.operationId}" is not in the spec`] };
  if (op.method !== 'get') errors.push(`collection: ${op.key} is not a GET`);
  const ok = op.responses.find((r) => /^2\d\d$/.test(r.status));
  const response = ok ? resolvePointer(doc, `/paths/${op.path.replace(/~/g, '~0').replace(/\//g, '~1')}/get/responses/${ok.status}/content/application~1json/schema`).node : undefined;
  if (!response) return { errors: [...errors, `collection: ${op.key} documents no JSON success schema`] };
  if (typeof cfg.items !== 'string' || !(cfg.items === '' || cfg.items.startsWith('/'))) errors.push('collection: "items" is a JSON pointer ("" for an array body)');
  const arr = schemaAt(doc, response, cfg.items ?? '');
  if (!arr || !typesOf(arr).includes('array')) errors.push(`collection: "${cfg.items}" is not an array in the ${op.key} response`);
  const itemSchema = deref(doc, arr?.items);
  const field = (ptr: string, what: string) => {
    if (typeof ptr !== 'string' || !ptr.startsWith('/')) errors.push(`collection: ${what} "${ptr}" is not a JSON pointer`);
    else if (itemSchema && !schemaAt(doc, itemSchema, ptr)) errors.push(`collection: ${what} "${ptr}" is not a field of the ${op.key} elements`);
  };
  field(cfg.id, '"id"');
  for (const [ptr, policy] of Object.entries(cfg.fields ?? {})) {
    field(ptr, 'field');
    if (!/^(exact|schema|ignore|tolerance:\d+(\.\d+)?)$/.test(policy)) errors.push(`collection: policy "${policy}" of ${ptr} is not exact, schema, ignore or tolerance:<n>`);
  }
  for (const u of cfg.unique ?? []) field(u, 'unique');
  const query = (name: string, what: string) => {
    if (!op.params.some((p) => p.in === 'query' && p.name === name)) errors.push(`collection: ${what} "${name}" is not a query parameter of ${op.key}`);
  };
  for (const f of cfg.filters ?? []) {
    query(f.param, 'filter parameter');
    field(f.field, 'filter field');
    if (!['equals', 'contains', 'search'].includes(f.match)) errors.push(`collection: filter match "${f.match}" is equals, contains or search`);
    if (f.match === 'search' && itemSchema && !typesOf(schemaAt(doc, itemSchema, f.field)).includes('string')) errors.push(`collection: search filter field "${f.field}" is not a string`);
  }
  for (const s of cfg.sorts ?? []) {
    query(s.param, 'sort parameter');
    field(s.field, 'sort field');
    const p = op.params.find((x) => x.name === s.param);
    const allowed = (p?.schema as any)?.enum;
    if (Array.isArray(allowed) && !allowed.map(String).includes(String(s.value))) errors.push(`collection: sort value "${s.value}" is not documented for "${s.param}"`);
    if (s.order !== 'asc' && s.order !== 'desc') errors.push('collection: sort order is asc or desc');
  }
  if (cfg.page) {
    if (cfg.page.style === 'offset') {
      query(cfg.page.offsetParam, 'offset parameter');
      query(cfg.page.limitParam, 'limit parameter');
    } else if (cfg.page.style === 'page') {
      query(cfg.page.pageParam, 'page parameter');
      if (cfg.page.sizeParam !== undefined) query(cfg.page.sizeParam, 'size parameter');
      else if (!(Number.isInteger(cfg.page.size) && cfg.page.size! > 0)) errors.push('collection: page style "page" needs "sizeParam", or the fixed page size "size" the API uses');
    } else errors.push('collection: page style is offset or page (cursor is not supported yet)');
  }
  if (cfg.strategy !== undefined && cfg.strategy !== 'read-only') errors.push('collection: "strategy" can only be "read-only"');
  if (cfg.strategy !== undefined && cfg.strategy !== 'read-only') errors.push('collection: "strategy" can only be "read-only"');
  if (cfg.total !== undefined) {
    const t = typeof cfg.total === 'string' && cfg.total.startsWith('/') ? schemaAt(doc, response, cfg.total) : undefined;
    if (!t || !typesOf(t).includes('integer')) errors.push(`collection: "total" ${cfg.total} is not an integer field of the ${op.key} response`);
  }
  const c = cfg.consistency;
  if (c && !(c.pollTimeoutMs > 0 && c.pollTimeoutMs <= 60_000 && c.pollIntervalMs > 0 && c.pollIntervalMs <= c.pollTimeoutMs)) errors.push('collection: consistency needs 0 < pollIntervalMs <= pollTimeoutMs <= 60000');
  if (errors.length) return { errors };
  return { collection: { ...cfg, op, itemSchema, maxPages: Math.min(cfg.page?.maxPages ?? 10, 50) }, errors };
}

/** The array holds resources (objects with properties), not scalar values. */
function collectionOfObjects(doc: OpenApiDoc, op: Operation, items: string): boolean {
  const ok = op.responses.find((r) => /^2\d\d$/.test(r.status));
  const schema = ok ? resolvePointer(doc, `/paths/${op.path.replace(/~/g, '~0').replace(/\//g, '~1')}/get/responses/${ok.status}/content/application~1json/schema`).node : undefined;
  const el = schemaAt(doc, schema, items + '/*');
  return !!el && (typesOf(el).includes('object') || !!el.allOf);
}

/** What deeper collection checks are missing for a GET list, and why (no config, no create, …). */
export function collectionGaps(doc: OpenApiDoc, op: Operation, configured: boolean): CoverageGap[] {
  // A path ending in a parameter reads one resource; its array fields (e.g. tags) are not a collection.
  if (op.method !== 'get' || configured || /\}$/.test(op.path)) return [];
  const items = detectItems(doc, op);
  if (items === undefined) return [];
  if (!collectionOfObjects(doc, op, items)) return [];
  return [{ code: 'UNCONFIRMED_BUSINESS_RULE', location: 'operation', reason: `collection${items ? ` at ${items}` : ''}: membership, filters, sorting and pagination need a reviewed "collection" mapping in the deps file (identifier field, filter / sort semantics, paging)` }];
}
