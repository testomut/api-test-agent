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
// Reference data present from the start (tag "catalog"): what demo-api/fixtures/approved/listItems.json approves.
for (const seed of [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Catalog hammer', price: 12.5, tags: ['catalog'] },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Catalog screwdriver', price: 4.25, tags: ['catalog'] },
]) items.set(seed.id, { ...seed, createdAt: new Date().toISOString() });
let lastCreated: string | undefined; // DEMO_FAULT=hide-created hides it from the list
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
  // DEMO_FAULT=require-optional: a documented optional field is required (tags on create, name on update).
  if (process.env.DEMO_FAULT === 'require-optional' && !(partial ? 'name' in b : 'tags' in b)) return partial ? 'name is required' : 'tags is required';
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
    const rawOffset = url.searchParams.get('offset');
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    if (!Number.isInteger(offset) || offset < 0) return error(res, 400, 'offset must be an integer >= 0');
    const sort = url.searchParams.get('sort');
    if (sort !== null && !['name', '-name', 'price', '-price'].includes(sort)) return error(res, 400, 'sort must be name, -name, price or -price');
    const tag = url.searchParams.get('tag');
    if (tag !== null && (tag.length < 1 || tag.length > 30)) return error(res, 400, 'tag must be 1-30 characters');
    // DEMO_FAULT simulates one collection defect at a time (mutation tests: the generated suite must catch each).
    const fault = process.env.DEMO_FAULT;
    let all = [...items.values()];
    if (tag !== null && fault !== 'ignore-filter') all = all.filter((i) => i.tags.includes(tag));
    if (fault === 'hide-created') all = all.filter((i) => i.id !== lastCreated);
    if (sort) {
      const key = sort.replace(/^-/, '') as 'name' | 'price';
      const dir = sort.startsWith('-') ? -1 : 1;
      all = [...all].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * dir * (fault === 'wrong-sort' ? -1 : 1));
    }
    if (fault === 'duplicate') all = all.flatMap((i) => [i, i]);
    const start = fault === 'bad-pagination' ? Math.max(0, offset - 1) : offset;
    let page = all.slice(start, start + limit);
    if (fault === 'wrong-field') page = page.map((i) => ({ ...i, price: i.price + 1 }));
    send(res, 200, { items: page, total: all.length });
  },
  POST: async (req, res) => {
    const body = await readJson(req);
    if (!body.ok) return error(res, 400, 'Invalid JSON');
    const v = validateItem(body.value, false);
    if (typeof v === 'string') return error(res, 400, v);
    const item: Item = { id: randomUUID(), name: v.name!, price: v.price!, tags: v.tags ?? [], createdAt: new Date().toISOString() };
    items.set(item.id, item);
    lastCreated = item.id;
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

// Short-lived tokens, like many real APIs: the agent and the generated tests must log in.
const DEMO_USER = process.env.DEMO_USER ?? 'demo';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password';
const TOKEN_TTL_SEC = Number(process.env.DEMO_TOKEN_TTL ?? 300);
const sessions = new Map<string, { username: string; expiresAt: number }>();
const accounts = new Map<string, string>([[DEMO_USER, DEMO_PASSWORD]]);
// Fixed sessions for the reviewed auth cases (demo-api/deps.json "auth"): an expired token of the demo user, and a
// valid token of a suspended account, which /me must refuse with 403.
const SUSPENDED = new Set(['suspended']);
sessions.set('demo-expired-token', { username: DEMO_USER, expiresAt: 0 });
sessions.set('demo-suspended-token', { username: 'suspended', expiresAt: Number.MAX_SAFE_INTEGER });

// Self-registration for API_TEST_ACCOUNT=new. Not in the spec on purpose: it is configured
// through API_REGISTER / API_REGISTER_BODY, like on APIs whose spec omits it.
route('/auth/register', {
  POST: async (req, res) => {
    const body = await readJson(req);
    const b = body.ok ? (body.value as Record<string, unknown>) : undefined;
    if (!b || typeof b.username !== 'string' || typeof b.password !== 'string' || b.password.length < 8) return error(res, 422, 'username and password (8+ chars) required');
    if (accounts.has(b.username)) return error(res, 409, 'Account exists');
    accounts.set(b.username, b.password);
    send(res, 201, { username: b.username });
  },
});

route('/auth/login', {
  POST: async (req, res) => {
    const body = await readJson(req);
    const b = body.ok ? (body.value as Record<string, unknown>) : undefined;
    if (!b || typeof b.username !== 'string' || accounts.get(b.username) !== b.password) return error(res, 401, 'Invalid credentials');
    const token = randomUUID();
    sessions.set(token, { username: b.username, expiresAt: Date.now() + TOKEN_TTL_SEC * 1000 });
    send(res, 200, { access_token: token, token_type: 'bearer', expires_in: TOKEN_TTL_SEC });
  },
});

route('/me', {
  GET: (req, res) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const s = sessions.get(token);
    // DEMO_FAULT=accept-expired / ignore-suspension: the check is missing (the reviewed auth cases must notice).
    if (!s || (s.expiresAt < Date.now() && process.env.DEMO_FAULT !== 'accept-expired')) return error(res, 401, 'Unauthorized');
    if (SUSPENDED.has(s.username) && process.env.DEMO_FAULT !== 'ignore-suspension') return error(res, 403, 'Account suspended');
    send(res, 200, { username: s.username });
  },
});

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
