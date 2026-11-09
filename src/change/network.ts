import { readFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ConfigError } from './types.js';

/** Network access for `diff` (docs/OPENAPI_CHANGE_TRIGGER.md, "Network access"): off unless --allow-network. */
export interface NetworkOptions {
  allowNetwork: boolean;
  /** When non-empty, only these hostnames may be fetched; listing a host also lifts the default deny for it. */
  allowHosts: string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export const isUrl = (s: string) => /^https?:\/\//i.test(s);

const DENIED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);

/** Loopback, private, link-local (incl. cloud metadata 169.254.169.254) and other non-public addresses. */
export function isDeniedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('::ffff:')) return isDeniedAddress(s.slice(7));
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
  }
  return false;
}

async function checkHost(url: URL, o: NetworkOptions): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allowed = o.allowHosts.map((h) => h.toLowerCase());
  if (allowed.length && !allowed.includes(host)) throw new ConfigError(`Host "${host}" is not in --allow-host (${allowed.join(', ')}).`);
  if (allowed.includes(host)) return;
  const denied = (why: string) => new ConfigError(`Host "${host}" is denied by default (${why}). Pass --allow-host ${host} if this is intended.`);
  if (DENIED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) throw denied('local or metadata host');
  if (isIP(host)) {
    if (isDeniedAddress(host)) throw denied('private, loopback or link-local address');
    return;
  }
  const addrs = await lookup(host, { all: true }).catch(() => []);
  if (addrs.some((a) => isDeniedAddress(a.address))) throw denied('resolves to a private, loopback or link-local address');
}

/** Reads a spec from a file, or from a URL when the network is allowed (redirects re-checked, size and time limited). */
export async function readSource(src: string, o: NetworkOptions): Promise<string> {
  if (!isUrl(src)) {
    try {
      return await readFile(src, 'utf8');
    } catch (e: any) {
      throw new ConfigError(`Cannot read ${src}: ${e?.code ?? e?.message ?? e}`);
    }
  }
  if (!o.allowNetwork) throw new ConfigError(`${src} is a URL: pass --allow-network to download it, or download it in a separate step and pass the file.`);
  const maxBytes = o.maxBytes ?? 20 * 1024 * 1024;
  const maxRedirects = o.maxRedirects ?? 5;
  let url = new URL(src);
  for (let hop = 0; ; hop++) {
    await checkHost(url, o);
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
    } catch (e: any) {
      throw new ConfigError(`Cannot download ${url.href}: ${e?.message ?? e}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= maxRedirects) throw new ConfigError(`Too many redirects for ${src} (limit ${maxRedirects}).`);
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) throw new ConfigError(`Cannot download ${url.href}: HTTP ${res.status}.`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new ConfigError(`${url.href} is larger than ${maxBytes} bytes.`);
    const reader = res.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ConfigError(`${url.href} is larger than ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
