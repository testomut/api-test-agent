import type { OpenApiDoc } from '../spec/loader.js';

/**
 * Credentials come only from environment variables (or the CI secret store that sets them).
 * They are never written to reports, logs or (later) AI prompts.
 *
 *   API_TOKEN               http bearer, oauth2, openIdConnect
 *   API_USER / API_PASSWORD http basic
 *   API_KEY                 apiKey (header or query)
 */
export interface Credentials {
  headers: Record<string, string>;
  query: Record<string, string>;
}

export type AuthResolution = { ok: true; creds: Credentials; schemes: string[] } | { ok: false; reason: string };

export function resolveAuth(doc: OpenApiDoc, alternatives: string[][], env: NodeJS.ProcessEnv = process.env): AuthResolution {
  if (!alternatives.length || alternatives.some((alt) => alt.length === 0)) {
    return { ok: true, creds: { headers: {}, query: {} }, schemes: [] };
  }
  const schemes = doc.components?.securitySchemes ?? {};
  const missing: string[] = [];

  for (const alt of alternatives) {
    const creds: Credentials = { headers: {}, query: {} };
    let satisfied = true;
    for (const name of alt) {
      const s = schemes[name];
      const need = applyScheme(s, creds, env);
      if (need) {
        satisfied = false;
        missing.push(`${name}: ${need}`);
      }
    }
    if (satisfied) return { ok: true, creds, schemes: alt };
  }
  return { ok: false, reason: `No credentials for required security (${[...new Set(missing)].join('; ')})` };
}

/** Returns a "what is missing" message, or undefined when the scheme was applied. */
function applyScheme(s: any, creds: Credentials, env: NodeJS.ProcessEnv): string | undefined {
  if (!s) return 'scheme is not defined in components.securitySchemes';
  if ((s.type === 'http' && /^bearer$/i.test(s.scheme)) || s.type === 'oauth2' || s.type === 'openIdConnect') {
    if (!env.API_TOKEN) return 'set API_TOKEN';
    creds.headers.Authorization = `Bearer ${env.API_TOKEN}`;
    return;
  }
  if (s.type === 'http' && /^basic$/i.test(s.scheme)) {
    if (!env.API_USER || !env.API_PASSWORD) return 'set API_USER and API_PASSWORD';
    creds.headers.Authorization = 'Basic ' + Buffer.from(`${env.API_USER}:${env.API_PASSWORD}`).toString('base64');
    return;
  }
  if (s.type === 'apiKey') {
    if (!env.API_KEY) return 'set API_KEY';
    if (s.in === 'header') creds.headers[s.name] = env.API_KEY;
    else if (s.in === 'query') creds.query[s.name] = env.API_KEY;
    else return `apiKey in ${s.in} is not supported by the MVP`;
    return;
  }
  return `scheme type "${s.type}" is not supported by the MVP`;
}

/** Remove anything credential-shaped before text reaches a log or report. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const k of ['API_TOKEN', 'API_KEY', 'API_PASSWORD']) {
    const v = env[k];
    if (v && v.length >= 4) out = out.split(v).join('***');
  }
  return out.replace(/(authorization|x-api-key|cookie)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2***');
}
