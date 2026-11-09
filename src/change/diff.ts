import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { headRevision, resolveBaseline } from './baseline.js';
import { mapChanges } from './map-changes.js';
import { readSource, type NetworkOptions } from './network.js';
import { normalizeSpec } from './normalize.js';
import { applyVerdicts, changelog, checkVersion, findOasdiff, preflight } from './oasdiff.js';
import { writeChangeReport } from './write-change-report.js';
import { ConfigError, type BlockedResult, type FailOn, type OpenApiChangeSet } from './types.js';

export interface DiffOptions extends NetworkOptions {
  base?: string;
  head: string;
  out: string;
  format: 'json' | 'markdown';
  failOn: FailOn[];
  allowEngineVersionMismatch: boolean;
  testsDir?: string;
  env?: NodeJS.ProcessEnv;
  log?: (m: string) => void;
}

/** --fail-on is repeatable; `never` stands alone. Default: blocked. */
export function parseFailOn(values: string[] | undefined): FailOn[] {
  const list = (values?.length ? values : ['blocked']).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  const allowed = ['breaking', 'blocked', 'unknown', 'never'];
  const bad = list.filter((v) => !allowed.includes(v));
  if (bad.length) throw new ConfigError(`Unknown --fail-on value ${bad.join(', ')}: use ${allowed.join(', ')}.`);
  if (list.includes('never') && list.length > 1) throw new ConfigError('--fail-on never cannot be combined with other values.');
  return [...new Set(list)] as FailOn[];
}

/** 0: analysis done and the policy passed; 1: a --fail-on policy triggered. (2 is a thrown ConfigError.) */
export function exitCodeFor(set: OpenApiChangeSet, failOn: FailOn[]): 0 | 1 {
  if (failOn.includes('never')) return 0;
  if (failOn.includes('blocked') && set.blocked.length) return 1;
  if (failOn.includes('breaking') && set.changes.some((c) => c.breaking === 'yes')) return 1;
  if (failOn.includes('unknown') && set.changes.some((c) => c.breaking === 'unknown')) return 1;
  return 0;
}

export async function runDiff(o: DiffOptions): Promise<{ set: OpenApiChangeSet; files: string[]; exitCode: 0 | 1 }> {
  const log = o.log ?? (() => undefined);
  const failOn = o.failOn.length ? o.failOn : parseFailOn(undefined);
  const net: NetworkOptions = { allowNetwork: o.allowNetwork, allowHosts: o.allowHosts, maxBytes: o.maxBytes, timeoutMs: o.timeoutMs, maxRedirects: o.maxRedirects };
  // Configuration first: a missing engine or a URL without --allow-network stops before any analysis (exit 2).
  const headRaw = await readSource(o.head, net);
  const bin = findOasdiff(o.env);
  const engine = { name: 'oasdiff' as const, ...(await checkVersion(bin, o.allowEngineVersionMismatch, log, o.env)) };
  const head = normalizeSpec(headRaw, o.head);
  const { baseline, blocked: baseBlocked } = await resolveBaseline({ base: o.base, head: o.head, testsDir: o.testsDir, env: o.env }, net);
  const set: OpenApiChangeSet = {
    baseRevision: baseline?.revision ?? '',
    headRevision: await headRevision(o.head),
    baseSource: baseline?.source ?? null,
    engine,
    changes: [],
    blocked: [...baseBlocked],
  };
  if (baseline) {
    const base = normalizeSpec(baseline.raw, o.base ?? `baseline (${baseline.source})`);
    // Remote $refs need the network; resolving external references is not supported in this version.
    const external = [...new Set([...base.externalRefs, ...head.externalRefs])];
    const remote = external.filter((r) => /^https?:/i.test(r));
    if (remote.length && !o.allowNetwork) throw new ConfigError(`The spec references remote documents (${remote.slice(0, 3).join(', ')}): pass --allow-network, or bundle the spec first.`);
    if (external.length) set.blocked.push({ code: 'EXTERNAL_REF_UNSUPPORTED', reason: `$refs to other documents are not resolved by diff yet: ${external.slice(0, 5).join(', ')}. Bundle the spec first (e.g. \`redocly bundle\`).` });
    const { changes, blocked } = mapChanges(base, head);
    set.changes = changes;
    set.blocked.push(...blocked);
    const engineBlocked: BlockedResult[] = [...preflight(base.raw, 'The base spec'), ...preflight(head.raw, 'The head spec')];
    set.blocked.push(...engineBlocked);
    if (!engineBlocked.length && changes.length) {
      // The engine reads files: they are written inside --out and removed afterwards.
      const dir = join(o.out, '.engine');
      await mkdir(dir, { recursive: true });
      try {
        await writeFile(join(dir, 'base.yaml'), baseline.raw);
        await writeFile(join(dir, 'head.yaml'), headRaw);
        const entries = await changelog(bin, join(dir, 'base.yaml'), join(dir, 'head.yaml'), o.env);
        const basePath = new Map(base.ops.map((op) => [op.uid, op.path]));
        applyVerdicts(set.changes, entries, (c) => {
          const [method, ...rest] = c.operationKey.split(' ');
          return { method, paths: [rest.join(' '), basePath.get(c.operationUid) ?? ''].filter(Boolean) };
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
  const files = await writeChangeReport(set, o.out, o.format);
  return { set, files, exitCode: exitCodeFor(set, failOn) };
}
