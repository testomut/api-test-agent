/**
 * Inventory Demo API: an in-memory target for api-test-agent.
 * Deliberate defect: GET /stats returns `total` as a string, while the spec says integer.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

interface Item {
  id: string;
  name: string;
  price: number;
  tags: string[];
  createdAt: string;
}

const items = new Map<string, Item>();
const ADMIN_TOKEN = process.env.DEMO_ADMIN_TOKEN ?? 'demo-admin-token';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
};
const error = (res: ServerResponse, status: number, message: string, headers?: Record<string, string>) =>
  send(res, status, { message }, headers);

async function readJson(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** Validates ItemInput (partial=false) or ItemPatch (partial=true). Returns an error message or the clean value. */
function validateItem(body: unknown, partial: boolean): string | Partial<Item> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Body must be a JSON object';
  const b = body as Record<string, unknown>;
  const allowed = ['name', 'price', 'tags'];
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length) return `Unknown fields: ${extra.join(', ')}`;
  if (partial && Object.keys(b).length === 0) return 'At least one field is required';
  const out: Partial<Item> = {};
  if ('name' in b || !partial) {
    if (typeof b.name !== 'string' || b.name.length < 1 || b.name.length > 100) return 'name must be a string of 1-100 characters';
    out.name = b.name;
  }
  if ('price' in b || !partial) {
    if (typeof b.price !== 'number' || !Number.isFinite(b.price) || b.price < 0) return 'price must be a number >= 0';
    out.price = b.price;
  }
  if ('tags' in b) {
    if (!Array.isArray(b.tags) || b.tags.length > 10 || !b.tags.every((t) => typeof t === 'string' && t.length >= 1 && t.length <= 30)) {
      return 'tags must be up to 10 strings of 1-30 characters';
    }
    out.tags = b.tags as string[];
  }
  return out;
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, url: URL) => Promise<void> | void;
const routes: { pattern: RegExp; keys: string[]; methods: Record<string, Handler> }[] = [];
const route = (path: string, methods: Record<string, Handler>) => {
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/\{(\w+)\}/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ pattern, keys, methods });
};

route('/health', { GET: (_q, res) => send(res, 200, { status: 'ok' }) });

route('/items', {
  GET: (_q, res, _p, url) => {
    const raw = url.searchParams.get('limit');
    const limit = raw === null ? 20 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return error(res, 400, 'limit must be an integer 1-100');
    const all = [...items.values()];
    send(res, 200, { items: all.slice(0, limit), total: all.length });
  },
  POST: async (req, res) => {
    const body = await readJson(req);
    if (!body.ok) return error(res, 400, 'Invalid JSON');
    const v = validateItem(body.value, false);
    if (typeof v === 'string') return error(res, 400, v);
    const item: Item = { id: randomUUID(), name: v.name!, price: v.price!, tags: v.tags ?? [], createdAt: new Date().toISOString() };
    items.set(item.id, item);
    // DEMO_BREAK=create-price simulates a regression so the agent's CONTRACT_MISMATCH path can be demonstrated.
    const out = process.env.DEMO_BREAK === 'create-price' ? { ...item, price: String(item.price) } : item;
    send(res, 201, out, { location: `/items/${item.id}` });
  },
});

const findItem = (res: ServerResponse, id: string) => {
  const item = UUID.test(id) ? items.get(id.toLowerCase()) : undefined;
  if (!item) error(res, 404, 'Item not found');
  return item;
};

route('/items/{itemId}', {
  GET: (_q, res, p) => {
    const item = findItem(res, p.itemId);
    if (item) send(res, 200, item);
  },
  PATCH: async (req, res, p) => {
    const item = findItem(res, p.itemId);
    if (!item) return;
    const body = await readJson(req);
    if (!body.ok) return error(res, 400, 'Invalid JSON');
    const v = validateItem(body.value, true);
    if (typeof v === 'string') return error(res, 400, v);
    Object.assign(item, v);
    send(res, 200, item);
  },
  DELETE: (_q, res, p) => {
    const item = findItem(res, p.itemId);
    if (!item) return;
    items.delete(item.id);
    send(res, 204);
  },
});

route('/stats', {
  GET: (_q, res) => {
    const all = [...items.values()];
    // BUG (intentional): total should be an integer per the spec.
    send(res, 200, { total: String(all.length), totalValue: all.reduce((s, i) => s + i.price, 0) });
  },
});

route('/reports/{reportId}', { GET: (_q, res) => error(res, 404, 'Report not found') });

route('/admin/reset', {
  POST: (req, res) => {
    if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return error(res, 401, 'Unauthorized');
    items.clear();
    send(res, 204);
  },
});

export function startDemoApi(port = Number(process.env.PORT ?? 3100)) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    for (const r of routes) {
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const handler = r.methods[req.method ?? 'GET'];
      if (!handler) return error(res, 405, 'Method not allowed', { allow: Object.keys(r.methods).join(', ') });
      try {
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return await handler(req, res, params, url);
      } catch {
        return error(res, 500, 'Internal error');
      }
    }
    error(res, 404, 'Not found');
  });
  return new Promise<typeof server>((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!)) {
  startDemoApi().then((s) => console.log(`Inventory Demo API on http://localhost:${(s.address() as any).port}`));
}
