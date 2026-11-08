import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import SwaggerParser from '@apidevtools/swagger-parser';
import { parse as parseYaml } from 'yaml';

export type OpenApiDoc = Record<string, any>;

export interface LoadedSpec {
  location: string;
  /** Single-file document; internal $refs kept (safe for circular schemas). */
  doc: OpenApiDoc;
  version: '3.0' | '3.1';
  /** Hash of the raw source: cache key for catalogue / dependency graph. */
  hash: string;
  /** Structural validation errors (empty when the spec is valid). */
  validationErrors: string[];
}

export class UnsupportedSpecError extends Error {}

async function readRaw(location: string): Promise<string> {
  if (/^https?:\/\//i.test(location)) {
    const res = await fetch(location, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Cannot download spec: HTTP ${res.status} ${location}`);
    return res.text();
  }
  return readFile(location, 'utf8');
}

export async function loadSpec(location: string): Promise<LoadedSpec> {
  const raw = await readRaw(location);
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  const parsed = parseYaml(raw) as OpenApiDoc;

  if (parsed?.swagger) {
    throw new UnsupportedSpecError(
      'Swagger 2.0 is not supported in this MVP. Convert it first, e.g. `npx swagger2openapi spec.yaml -o openapi.yaml`.',
    );
  }
  const v = String(parsed?.openapi ?? '');
  if (!/^3\.(0|1|2)\./.test(v)) throw new UnsupportedSpecError(`Unknown OpenAPI version "${v || 'missing'}".`);

  // OpenAPI 3.2 keeps 3.1's schema dialect (JSON Schema 2020-12): structure is processed as 3.1.
  const is32 = v.startsWith('3.2');
  const asParsed = is32 ? { ...parsed, openapi: '3.1.1' } : parsed;
  const bundled = (await SwaggerParser.bundle(structuredClone(asParsed) as any)) as OpenApiDoc;

  const validationErrors: string[] = [];
  if (is32) validationErrors.push(`OpenAPI ${v}: validated with the 3.1 rules; features new in 3.2 (e.g. QUERY method, additionalOperations) are not checked.`);
  try {
    await SwaggerParser.validate(structuredClone(bundled) as any);
  } catch (err: any) {
    const details = Array.isArray(err?.details) ? err.details.map((d: any) => `${d.instancePath ?? ''} ${d.message}`) : [];
    validationErrors.push(...(details.length ? details : [String(err?.message ?? err)]));
  }
  const doc = is32 ? { ...bundled, openapi: v } : bundled;

  return { location, doc, version: v.startsWith('3.0') ? '3.0' : '3.1', hash, validationErrors };
}

/** Resolve a JSON pointer inside the document, following whole-object $refs. Returns the final pointer too. */
export function resolvePointer(doc: OpenApiDoc, pointer: string): { node: any; pointer: string } {
  let node: any = doc;
  let current = '';
  const parts = pointer.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const part of parts) {
    ({ node, pointer: current } = followRef(doc, node, current));
    if (node == null) return { node: undefined, pointer: current };
    node = node[part];
    current += '/' + part.replace(/~/g, '~0').replace(/\//g, '~1');
  }
  return followRef(doc, node, current);
}

function followRef(doc: OpenApiDoc, node: any, pointer: string, depth = 0): { node: any; pointer: string } {
  if (node && typeof node === 'object' && typeof node.$ref === 'string' && node.$ref.startsWith('#') && depth < 20) {
    const target = node.$ref.slice(1);
    return resolvePointer(doc, target.startsWith('/') ? target : '/' + target);
  }
  return { node, pointer };
}

export function escapePointer(part: string): string {
  return part.replace(/~/g, '~0').replace(/\//g, '~1');
}
