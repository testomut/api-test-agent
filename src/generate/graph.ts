import type { Operation } from '../types.js';
import { resolvePointer, type OpenApiDoc } from '../spec/loader.js';
import { operationPointer } from '../spec/catalog.js';

/**
 * A CRUD chain: create → read → update → delete for one resource.
 * Only CONFIRMED chains become tests. A dependency is confirmed when it is written down:
 * an OpenAPI `links` object, or an explicit deps file reviewed by a human.
 * Path similarity alone (POST /x + GET /x/{id}) is a CANDIDATE and is reported as BLOCKED.
 */
export interface CrudChain {
  name: string;
  create: Operation;
  idPointer: string; // JSON pointer into the create response body, e.g. "/id"
  param: string; // path parameter that receives the id
  read?: Operation;
  update?: Operation;
  delete?: Operation;
  source: string;
}

export interface Candidate {
  name: string;
  operations: string[];
  question: string;
}

export interface DepsFile {
  scenarios: { create: string; idFrom: string; param: string; read?: string; update?: string; delete?: string }[];
}

const RUNTIME_EXPR = /^\$response\.body#(\/.*)$/;

export function findChains(doc: OpenApiDoc, ops: Operation[], deps?: DepsFile): { chains: CrudChain[]; candidates: Candidate[] } {
  const byId = new Map(ops.filter((o) => o.operationId).map((o) => [o.operationId!, o]));
  const chains: CrudChain[] = [];

  // 1) Explicit deps file (human-confirmed).
  for (const s of deps?.scenarios ?? []) {
    const create = byId.get(s.create);
    if (!create) continue;
    chains.push({
      name: `${s.create} lifecycle`,
      create,
      idPointer: s.idFrom,
      param: s.param,
      read: s.read ? byId.get(s.read) : undefined,
      update: s.update ? byId.get(s.update) : undefined,
      delete: s.delete ? byId.get(s.delete) : undefined,
      source: 'deps file (human-confirmed)',
    });
  }

  // 2) OpenAPI links on the create operation's 2xx responses.
  for (const op of ops.filter((o) => o.method === 'post')) {
    if (chains.some((c) => c.create === op)) continue;
    const responses = resolvePointer(doc, `${operationPointer(op)}/responses`).node ?? {};
    const linked: { target: Operation; param: string; pointer: string; linkName: string }[] = [];
    for (const [status, r] of Object.entries<any>(responses)) {
      if (!/^2/.test(status)) continue;
      const resp = r?.$ref ? resolvePointer(doc, r.$ref.slice(1)).node : r;
      for (const [linkName, l] of Object.entries<any>(resp?.links ?? {})) {
        const link = l?.$ref ? resolvePointer(doc, l.$ref.slice(1)).node : l;
        const target = link?.operationId ? byId.get(link.operationId) : undefined;
        if (!target) continue;
        for (const [param, expr] of Object.entries<any>(link.parameters ?? {})) {
          const m = typeof expr === 'string' ? RUNTIME_EXPR.exec(expr) : null;
          const name = param.replace(/^path\./, '');
          if (m && target.params.some((p) => p.in === 'path' && p.name === name)) linked.push({ target, param: name, pointer: m[1], linkName });
        }
      }
    }
    if (!linked.length) continue;
    const { param, pointer } = linked[0];
    const same = linked.filter((l) => l.param === param && l.pointer === pointer);
    const pick = (...methods: string[]) => same.find((l) => methods.includes(l.target.method))?.target;
    chains.push({
      name: `${op.operationId ?? op.key} lifecycle`,
      create: op,
      idPointer: pointer,
      param,
      read: pick('get'),
      update: pick('patch', 'put'),
      delete: pick('delete'),
      source: `OpenAPI links on ${op.operationId ?? op.key} (${same.map((l) => l.linkName).join(', ')})`,
    });
  }

  // 3) Unconfirmed candidates: collection POST + item path, no written dependency.
  const candidates: Candidate[] = [];
  for (const op of ops.filter((o) => o.method === 'post')) {
    if (chains.some((c) => c.create === op)) continue;
    const item = ops.filter((o) => o.path.startsWith(op.path.replace(/\/$/, '') + '/{') && o.path.split('/').length === op.path.split('/').length + 1);
    if (!item.length) continue;
    const param = /\{([^}]+)\}$/.exec(item[0].path)?.[1] ?? 'id';
    candidates.push({
      name: `${op.operationId ?? op.key} lifecycle (unconfirmed)`,
      operations: [op.key, ...item.map((o) => o.key)],
      question:
        `Is the path parameter "${param}" of ${item[0].path} the identifier returned by ${op.key}, and at which JSON pointer of the response body? ` +
        `Confirm by adding OpenAPI "links" to the ${op.key} success response, or a deps file entry {"create":"${op.operationId ?? '?'}","idFrom":"/id","param":"${param}"}.`,
    });
  }
  return { chains, candidates };
}
