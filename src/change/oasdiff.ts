import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { ConfigError, type BlockedResult, type Breaking, type OpenApiChange } from './types.js';

/**
 * oasdiff as the external compatibility engine (docs/OPENAPI_CHANGE_TRIGGER.md, "Compatibility engine").
 * The binary is not bundled: OASDIFF_BIN or PATH. CI installs exactly this version.
 */
export const SUPPORTED_OASDIFF_VERSION = '1.34.1';

export const INSTALL_HINT = `Install oasdiff ${SUPPORTED_OASDIFF_VERSION}: download it from https://github.com/oasdiff/oasdiff/releases/tag/v${SUPPORTED_OASDIFF_VERSION} (or \`go install github.com/oasdiff/oasdiff@v${SUPPORTED_OASDIFF_VERSION}\`), then put it on PATH or set OASDIFF_BIN.`;

/** oasdiff changelog entry (JSON format). Only these fields are used. */
export interface OasdiffEntry {
  id: string;
  level: number; // 1 info, 2 warning, 3 error (breaking)
  operation?: string;
  path?: string;
  text?: string;
}

export function findOasdiff(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OASDIFF_BIN) {
    if (!existsSync(env.OASDIFF_BIN)) throw new ConfigError(`OASDIFF_BIN=${env.OASDIFF_BIN} does not exist. ${INSTALL_HINT}`);
    return env.OASDIFF_BIN;
  }
  const names = process.platform === 'win32' ? ['oasdiff.exe', 'oasdiff'] : ['oasdiff'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const n of names) if (existsSync(join(dir, n))) return join(dir, n);
  }
  throw new ConfigError(`oasdiff was not found. ${INSTALL_HINT}`);
}

/** Runs the engine. A .js / .mjs OASDIFF_BIN runs with Node (used by the tests' fake engine). */
export function runOasdiff(bin: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  const [cmd, argv] = /\.m?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
  return new Promise((done, fail) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => fail(new ConfigError(`Cannot run oasdiff (${bin}): ${e.message}. ${INSTALL_HINT}`)));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

/** Exact version match, or a warning with --allow-engine-version-mismatch; anything else is exit code 2. */
export async function checkVersion(bin: string, allowMismatch: boolean, warn: (m: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<{ version: string; versionMismatch: boolean }> {
  const VERSION = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/;
  let r = await runOasdiff(bin, ['--version'], env);
  let m = `${r.stdout}\n${r.stderr}`.match(VERSION);
  if (!m) {
    r = await runOasdiff(bin, ['version'], env);
    m = `${r.stdout}\n${r.stderr}`.match(VERSION);
  }
  if (!m) throw new ConfigError(`Unrecognized \`oasdiff --version\` output: ${(r.stdout || r.stderr).trim().slice(0, 200)}`);
  const version = m[1];
  if (version === SUPPORTED_OASDIFF_VERSION) return { version, versionMismatch: false };
  if (!allowMismatch) throw new ConfigError(`oasdiff ${version} found, ${SUPPORTED_OASDIFF_VERSION} expected. Install the pinned version, or pass --allow-engine-version-mismatch to test another one deliberately.`);
  warn(`WARNING: oasdiff ${version} is not the supported ${SUPPORTED_OASDIFF_VERSION}; continuing because of --allow-engine-version-mismatch.`);
  return { version, versionMismatch: true };
}

/** Constructs oasdiff parses but does not fully resolve: the comparison would be unreliable. */
export function preflight(doc: any, label: string): BlockedResult[] {
  const pointers: string[] = [];
  const walk = (node: any, ptr: string) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${ptr}/${i}`));
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const p = `${ptr}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (k === '$dynamicRef' || k === '$dynamicAnchor') pointers.push(p);
      walk(v, p);
    }
  };
  walk(doc, '');
  if (doc?.components?.pathItems && Object.keys(doc.components.pathItems).length) pointers.push('/components/pathItems');
  return pointers.length ? [{ code: 'OASDIFF_UNSUPPORTED_CONSTRUCT', pointers, reason: `${label} uses $dynamicRef / $dynamicAnchor or components.pathItems, which oasdiff does not fully resolve.` }] : [];
}

export async function changelog(bin: string, baseFile: string, headFile: string, env: NodeJS.ProcessEnv = process.env): Promise<OasdiffEntry[]> {
  const r = await runOasdiff(bin, ['changelog', baseFile, headFile, '--format', 'json'], env);
  if (r.code !== 0) throw new ConfigError(`oasdiff changelog failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  const text = r.stdout.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new ConfigError(`oasdiff changelog returned output that is not JSON: ${text.slice(0, 200)}`);
  }
}

/** Words of oasdiff rule ids that correspond to a facet (ids look like "request-property-max-length-decreased"). */
const FACET_WORDS: Record<string, string[]> = {
  required: ['required'],
  nullable: ['nullable'],
  type: ['type'],
  format: ['format'],
  pattern: ['pattern'],
  minimum: ['-min-', 'min-increased', 'min-decreased', 'min-set'],
  maximum: ['-max-', 'max-increased', 'max-decreased', 'max-set'],
  exclusiveMinimum: ['exclusive-min'],
  exclusiveMaximum: ['exclusive-max'],
  multipleOf: ['multiple-of'],
  minLength: ['min-length'],
  maxLength: ['max-length'],
  enum: ['enum'],
  const: ['const'],
  minItems: ['min-items'],
  maxItems: ['max-items'],
  uniqueItems: ['unique-items'],
  minProperties: ['min-properties'],
  maxProperties: ['max-properties'],
  additionalProperties: ['additional-properties'],
};

const KIND_WORDS: Partial<Record<OpenApiChange['kind'], string[]>> = {
  'operation-removed': ['api-removed', 'api-path-removed', 'endpoint-removed', 'path-removed'],
  'operation-moved': ['api-removed', 'api-path-removed', 'path-removed'],
  'parameter-changed': ['parameter'],
  'request-changed': ['request-body', 'request-property', 'request-media-type', 'security', 'request'],
  'response-changed': ['response-success-status', 'response-non-success-status', 'response-property', 'response-media-type', 'response'],
};

const lastSegment = (pointer?: string) => (pointer ?? '').split('/').filter(Boolean).pop()?.replace(/~1/g, '/').replace(/~0/g, '~');

/**
 * Fills `breaking` from the oasdiff changelog: entries of the same operation whose rule id matches the change's
 * kind / facet and direction. A matched error-level entry → 'yes', matched lower levels → 'no', no match → 'unknown'.
 * Verdicts fixed by the kind itself (added operation, example, servers, renames) are kept.
 */
export function applyVerdicts(changes: OpenApiChange[], entries: OasdiffEntry[], keyOf: (c: OpenApiChange) => { method: string; paths: string[] }): void {
  for (const c of changes) {
    if (c.breaking !== 'unknown') continue;
    const { method, paths } = keyOf(c);
    const forOp = entries.filter((e) => (e.operation ?? '').toUpperCase() === method && paths.includes(e.path ?? ''));
    let words: string[] = [];
    if (c.kind === 'schema-constraint-changed' && c.facet) words = FACET_WORDS[c.facet] ?? [];
    else words = KIND_WORDS[c.kind] ?? [];
    const scopeOk = (id: string) => !c.scope || (c.scope === 'request' ? !id.startsWith('response-') : !id.startsWith('request-'));
    const field = lastSegment(c.pointer);
    let matched = forOp.filter((e) => scopeOk(e.id) && words.some((w) => `-${e.id}-`.includes(w)));
    // Prefer entries that name the changed field, when the text names one.
    const named = matched.filter((e) => field && (e.text ?? '').includes(field));
    if (named.length) matched = named;
    if (!matched.length) continue;
    c.breaking = (matched.some((e) => e.level >= 3) ? 'yes' : 'no') as Breaking;
  }
}
