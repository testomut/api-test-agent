import { SAFE_METHODS, type HttpMethod } from '../types.js';

export interface SafeClientOptions {
  baseUrl: string;
  maxRequests: number;
  timeoutMs: number;
  requestsPerSecond: number;
  allowWrite: boolean;
}

export interface SafeResponse {
  status: number;
  contentType: string | null;
  body: unknown; // parsed JSON, raw text, or undefined when JSON was declared but unparseable
  elapsedMs: number;
}

export class BudgetExceeded extends Error {}
export class WriteNotAllowed extends Error {}

/**
 * The only way the agent talks to the API under test.
 * Enforces: method allow-list, request budget, per-request timeout, rate limit.
 * Logs never include headers or bodies.
 */
export class SafeClient {
  private sent = 0;
  private lastAt = 0;

  constructor(private readonly opts: SafeClientOptions) {}

  get requestsSent() {
    return this.sent;
  }

  async request(
    method: HttpMethod,
    pathAndQuery: string,
    init: { headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<SafeResponse> {
    if (!SAFE_METHODS.includes(method) && !this.opts.allowWrite) {
      throw new WriteNotAllowed(`${method.toUpperCase()} is disabled (pass --allow-write for a test environment)`);
    }
    if (this.sent >= this.opts.maxRequests) throw new BudgetExceeded(`Request budget of ${this.opts.maxRequests} is spent`);

    const gap = 1000 / this.opts.requestsPerSecond;
    const wait = this.lastAt + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastAt = Date.now();
    this.sent++;

    const url = new URL(pathAndQuery.replace(/^\//, ''), this.opts.baseUrl.endsWith('/') ? this.opts.baseUrl : this.opts.baseUrl + '/');
    const started = Date.now();
    const res = await fetch(url, {
      method: method.toUpperCase(),
      headers: { accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    const contentType = res.headers.get('content-type');
    const text = await res.text();
    let body: unknown = text;
    if (contentType?.includes('json')) {
      try {
        body = text.length ? JSON.parse(text) : null;
      } catch {
        body = undefined;
      }
    }
    return { status: res.status, contentType, body, elapsedMs: Date.now() - started };
  }
}
