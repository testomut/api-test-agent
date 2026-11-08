import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Postman collection v2.x analysis: requests, assertions and variable chains.
 * A variable set in one request's script (pm.environment.set("orderId", ...)) and used as
 * {{orderId}} in a later request is a dependency the team has already confirmed in practice.
 */
export interface PostmanRequest {
  index: number;
  name: string;
  folder: string;
  method: string;
  path: string; // "/orders/{orderId}"
  produces: string[];
  consumes: string[];
  statuses: number[]; // asserted in test scripts
  examples: number[]; // status codes of saved example responses
  tests: number; // pm.test(...) count
  hardcodedAuth: boolean;
  /** Raw request body (mode "raw"), if any. */
  body?: string;
  /** Headers except Authorization (credentials come from the environment). */
  headers: { key: string; value: string }[];
  /** Enabled query parameters. */
  query: { key: string; value: string }[];
  /** Test-script lines, kept for review when they cannot be converted. */
  testScript: string[];
}

export interface PostmanEdge {
  from: PostmanRequest;
  to: PostmanRequest;
  variable: string;
  outOfOrder: boolean;
}

export interface PostmanCollection {
  name: string;
  source: string; // file path or "postman cloud"
  requests: PostmanRequest[];
  edges: PostmanEdge[];
}

export async function loadPostman(ref: string, root: string, apiKey?: string): Promise<PostmanCollection> {
  const file = resolve(root, ref);
  let raw: any;
  let source: string;
  if (existsSync(file)) {
    raw = JSON.parse(await readFile(file, 'utf8'));
    source = ref;
  } else if (/\.json$/i.test(ref)) {
    throw new Error(`POSTMAN_COLLECTION file not found: ${ref}`);
  } else {
    if (!apiKey) throw new Error('POSTMAN_COLLECTION looks like a cloud collection id, but POSTMAN_API_KEY is not set.');
    const res = await fetch(`https://api.getpostman.com/collections/${encodeURIComponent(ref)}`, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Postman API returned ${res.status} for collection ${ref} (check the id and POSTMAN_API_KEY).`);
    raw = ((await res.json()) as any).collection;
    source = 'postman cloud';
  }
  return parsePostman(raw, source);
}

const VAR = /\{\{\s*([\w.-]+)\s*\}\}/g;
const SETTER = /(?:pm\.(?:environment|collectionVariables|globals|variables)\.set|postman\.set(?:Environment|Global)Variable)\(\s*["'`]([\w.-]+)["'`]/g;
const STATUS = /(?:\.to\.have\.status\(\s*(\d{3})|response\.code\)\.to\.(?:eql|equal|be\.equal)\(\s*(\d{3})|\.to\.be\.oneOf\(\s*\[([\d\s,]+)\]|responseCode\.code\s*===?\s*(\d{3}))/g;

function urlPath(url: any): { path: string; leadingVar?: string } {
  let raw: string = typeof url === 'string' ? url : url?.raw ?? '/' + (url?.path ?? []).join('/');
  raw = raw.replace(/^https?:\/\/[^/]+/i, '');
  const lead = /^\{\{\s*([\w.-]+)\s*\}\}/.exec(raw);
  if (lead) raw = raw.slice(lead[0].length).replace(/^https?:\/\/[^/]+/i, '');
  let path = raw.split('?')[0].split('#')[0];
  path = path.replace(VAR, '{$1}').replace(/\/:([\w-]+)/g, '/{$1}');
  if (!path.startsWith('/')) path = '/' + path;
  return { path: path.replace(/\/+$/, '') || '/', leadingVar: lead?.[1] };
}

export function parsePostman(collection: any, source: string): PostmanCollection {
  const requests: PostmanRequest[] = [];
  const visit = (items: any[], folder: string) => {
    for (const it of items ?? []) {
      if (Array.isArray(it.item)) {
        visit(it.item, folder ? `${folder} / ${it.name}` : it.name);
        continue;
      }
      const r = it.request;
      if (!r) continue;
      const scripts = (it.event ?? []).flatMap((e: any) => [].concat(e?.script?.exec ?? [])).join('\n');
      const { path, leadingVar } = urlPath(r.url);
      const urlText = typeof r.url === 'string' ? r.url : r.url?.raw ?? '';
      const headers: any[] = r.header ?? [];
      const consumed = new Set<string>();
      for (const text of [urlText, JSON.stringify(r.body ?? ''), JSON.stringify(headers)]) for (const m of text.matchAll(VAR)) consumed.add(m[1]);
      if (leadingVar) consumed.delete(leadingVar);
      const statuses: number[] = [];
      for (const m of scripts.matchAll(STATUS)) {
        const nums = (m[1] ?? m[2] ?? m[4] ?? m[3] ?? '').split(',').map((s: string) => Number(s.trim())).filter((n: number) => n >= 100 && n < 600);
        statuses.push(...nums);
      }
      const auth = headers.find((h) => /^authorization$/i.test(h?.key ?? ''));
      const testScript: string[] = (it.event ?? []).filter((e: any) => e?.listen === 'test').flatMap((e: any) => [].concat(e?.script?.exec ?? []));
      requests.push({
        body: r.body?.mode === 'raw' && typeof r.body.raw === 'string' && r.body.raw.trim() ? r.body.raw : undefined,
        headers: headers.filter((h) => h && !h.disabled && h.key && !/^authorization$/i.test(h.key)).map((h) => ({ key: String(h.key), value: String(h.value ?? '') })),
        query: (typeof r.url === 'object' ? r.url?.query ?? [] : []).filter((q: any) => q && !q.disabled && q.key).map((q: any) => ({ key: String(q.key), value: String(q.value ?? '') })),
        testScript,
        index: requests.length,
        name: it.name ?? `${r.method} ${path}`,
        folder,
        method: String(r.method ?? 'GET').toUpperCase(),
        path,
        produces: [...new Set([...scripts.matchAll(SETTER)].map((m) => m[1]))],
        consumes: [...consumed],
        statuses: [...new Set(statuses)],
        examples: [...new Set<number>((it.response ?? []).map((x: any) => Number(x.code)).filter(Boolean))],
        tests: (scripts.match(/pm\.test\(/g) ?? []).length,
        hardcodedAuth: !!auth && typeof auth.value === 'string' && !/\{\{/.test(auth.value) && auth.value.length > 12,
      });
    }
  };
  visit(collection?.item ?? [], '');

  const edges: PostmanEdge[] = [];
  for (const to of requests) {
    for (const v of to.consumes) {
      const before = requests.filter((r) => r.index < to.index && r.produces.includes(v));
      const any = before.length ? before[before.length - 1] : requests.find((r) => r !== to && r.produces.includes(v));
      if (any) edges.push({ from: any, to, variable: v, outOfOrder: any.index > to.index });
    }
  }
  return { name: collection?.info?.name ?? 'Postman collection', source, requests, edges };
}
