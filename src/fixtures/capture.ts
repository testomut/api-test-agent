import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenApiDoc } from '../spec/loader.js';
import type { Operation } from '../types.js';
import { detectItems } from '../generate/collection.js';
import { requiredRequest } from '../generate/param-cases.js';
import { diffFixtures, readPointer, validateFixture, type Fixture, type FixtureDiff } from './fixtures.js';

/**
 * `fixtures capture`: reads a collection (GET only) and writes a CANDIDATE fixture. It never writes the approved
 * directory: a candidate is trusted only after a person reviews it and moves it there (`fixtures refresh --draft-pr`
 * opens that review). Settings (query, items, id, policies, paging) come from the approved fixture when there is one,
 * else from the options and the deps file "collection" mapping.
 */

export interface CaptureOptions {
  doc: OpenApiDoc;
  ops: Operation[];
  baseUrl: string;
  operationId: string;
  approvedDir: string;
  candidatesDir: string;
  query?: Record<string, string>;
  items?: string;
  id?: string;
  /** Deps file "collection" entries: items / id / field policies / paging of a reviewed list operation. */
  collections?: { operationId: string; items: string; id: string; fields?: Record<string, string>; page?: any }[];
  headers?: Record<string, string>;
}

export interface CaptureResult {
  candidateFile: string;
  candidate: Fixture;
  approvedFile?: string;
  diff?: FixtureDiff;
}

export async function captureFixture(o: CaptureOptions): Promise<CaptureResult> {
  const op = o.ops.find((x) => x.operationId === o.operationId);
  if (!op) throw new Error(`Operation "${o.operationId}" is not in the spec.`);
  if (op.method !== 'get') throw new Error(`${op.key} is not a GET: capture only reads data.`);
  const approvedFile = join(o.approvedDir, `${o.operationId}.json`);
  const approved: Fixture | undefined = existsSync(approvedFile) ? JSON.parse(await readFile(approvedFile, 'utf8')) : undefined;
  const coll = o.collections?.find((c) => c.operationId === o.operationId);
  const items = approved?.items ?? o.items ?? coll?.items ?? detectItems(o.doc, op);
  const id = approved?.id ?? o.id ?? coll?.id;
  if (items === undefined) throw new Error(`Cannot tell where the array is in the ${op.key} response: pass --items <pointer>.`);
  if (!id) throw new Error(`Which field identifies an element? Pass --id <pointer> (e.g. /id).`);
  const page = approved?.page ?? (coll?.page ? { ...coll.page } : undefined);
  const query = { ...(approved?.query ?? {}), ...(o.query ?? {}) };
  const policies = approved?.policies ?? Object.fromEntries(Object.entries(coll?.fields ?? {}).filter(([, p]) => p !== 'exact'));

  const expected: unknown[] = [];
  const size = page?.size ?? 50;
  const maxPages = Math.min(page?.maxPages ?? 20, 50);
  const url = (i: number) => {
    const u = new URL(op.path.replace(/^\//, ''), o.baseUrl.replace(/\/?$/, '/'));
    for (const [k, v] of Object.entries({ ...requiredRequest(op).params, ...query })) u.searchParams.set(k, String(v));
    if (page?.style === 'offset') {
      u.searchParams.set(page.offsetParam, String(i * size));
      u.searchParams.set(page.limitParam, String(size));
    } else if (page?.style === 'page') {
      u.searchParams.set(page.pageParam, String(i + (page.firstPage ?? 1)));
      if (page.sizeParam !== undefined) u.searchParams.set(page.sizeParam, String(size));
    }
    return u;
  };
  if (/\{/.test(op.path)) throw new Error(`${op.key} has path parameters: capture reads collections without them.`);
  for (let i = 0; i < (page ? maxPages : 1); i++) {
    const res = await fetch(url(i), { headers: { accept: 'application/json', ...(o.headers ?? {}) } });
    if (!res.ok) throw new Error(`${op.key} answered ${res.status}: nothing captured.`);
    const body = await res.json();
    const arr = items ? readPointer(body, items) : body;
    if (!Array.isArray(arr)) throw new Error(`${op.key}: no array at "${items}".`);
    expected.push(...arr);
    if (!page || arr.length < size) break;
  }
  const candidate: Fixture = {
    schemaVersion: 1,
    operationId: o.operationId,
    ...(Object.keys(query).length ? { query } : {}),
    items,
    id,
    ...(Object.keys(policies).length ? { policies } : {}),
    default: approved?.default ?? 'exact',
    exhaustive: approved?.exhaustive ?? false,
    ...(page ? { page } : {}),
    expected,
    captured: { at: new Date().toISOString(), from: new URL(o.baseUrl).host },
  };
  const v = validateFixture(o.doc, o.ops, candidate);
  if (v.errors.length) throw new Error(`The captured candidate is not a valid fixture:\n  ${v.errors.join('\n  ')}`);
  await mkdir(o.candidatesDir, { recursive: true });
  const candidateFile = join(o.candidatesDir, `${o.operationId}.json`);
  await writeFile(candidateFile, JSON.stringify(candidate, null, 2) + '\n');
  return { candidateFile, candidate, ...(approved ? { approvedFile, diff: diffFixtures(approved, candidate) } : {}) };
}

/** Markdown summary of a candidate for review (Draft PR body). */
export function candidateSummary(r: CaptureResult): string {
  const L = [`## Fixture candidate: ${r.candidate.operationId}`, '', `Captured ${r.candidate.captured?.at} from ${r.candidate.captured?.from}: ${r.candidate.expected.length} element(s).`, ''];
  if (!r.diff) L.push(`No approved fixture yet. Review the data, then move \`${r.candidateFile.replace(/\\/g, '/')}\` to \`fixtures/approved/\` in this PR to approve it.`);
  else {
    L.push(`Compared with the approved \`${r.approvedFile!.replace(/\\/g, '/')}\` under its policies:`, '');
    L.push(`- elements added: ${r.diff.added.length}${r.diff.added.length ? ` (${r.diff.added.slice(0, 10).join(', ')})` : ''}`);
    L.push(`- elements removed: ${r.diff.removed.length}${r.diff.removed.length ? ` (${r.diff.removed.slice(0, 10).join(', ')})` : ''}`);
    L.push(`- fields changed: ${r.diff.changed.length}`);
    for (const c of r.diff.changed.slice(0, 20)) L.push(`  - ${c.id} ${c.pointer}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
    L.push('', 'The approved fixture is unchanged. If the new data is correct, replace the approved file with the candidate in this PR; if not, the API changed in a way the tests should report.');
  }
  L.push('', 'Never merge a fixture refresh without reading it: approving wrong data turns a defect into an expectation.');
  return L.join('\n') + '\n';
}
