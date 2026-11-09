import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isUrl, readSource, type NetworkOptions } from './network.js';
import type { BaseSource, BlockedResult } from './types.js';

/**
 * The "before" spec (docs/OPENAPI_CHANGE_TRIGGER.md, "Baseline"), in priority order:
 * --base, the spec at the Git merge base, a CI artifact, the suite's snapshot.
 * Not finding one is BLOCKED: BASE_SPEC_MISSING, an analysis result. A live URL is never compared with itself.
 */
export interface Baseline {
  raw: string;
  revision: string;
  source: BaseSource;
}

const git = (cwd: string, args: string[]) =>
  new Promise<{ ok: boolean; out: string }>((done) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => done({ ok: !err, out: String(stdout) }));
  });

/** The base branch a PR is compared with: GITHUB_BASE_REF / CHANGE_TARGET (Jenkins), else origin's default branch. */
async function baseRef(cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const named = env.GITHUB_BASE_REF || env.CHANGE_TARGET;
  if (named) return `origin/${named}`;
  const head = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.out.trim()) return head.out.trim();
  for (const r of ['origin/main', 'origin/master']) if ((await git(cwd, ['rev-parse', '--verify', '--quiet', r])).ok) return r;
  return undefined;
}

export async function resolveBaseline(
  o: { base?: string; head: string; testsDir?: string; env?: NodeJS.ProcessEnv },
  net: NetworkOptions,
): Promise<{ baseline?: Baseline; blocked: BlockedResult[] }> {
  const env = o.env ?? process.env;
  // 1. Explicit --base.
  if (o.base) return { baseline: { raw: await readSource(o.base, net), revision: o.base, source: 'flag' }, blocked: [] };

  const tried: string[] = [];
  // 2. The head file at the Git merge base.
  if (!isUrl(o.head) && existsSync(o.head)) {
    const dir = dirname(resolve(o.head));
    const top = await git(dir, ['rev-parse', '--show-toplevel']);
    if (!top.ok) tried.push('merge base: the head spec is not in a Git repository');
    else {
      const ref = await baseRef(dir, env);
      const mb = ref ? await git(dir, ['merge-base', 'HEAD', ref]) : { ok: false, out: '' };
      if (!ref) tried.push('merge base: no base branch (set GITHUB_BASE_REF, or fetch origin)');
      else if (!mb.ok || !mb.out.trim()) tried.push(`merge base: no merge base between HEAD and ${ref}`);
      else {
        const sha = mb.out.trim();
        const rel = relative(top.out.trim(), resolve(o.head)).replace(/\\/g, '/');
        const shown = await git(top.out.trim(), ['show', `${sha}:${rel}`]);
        if (shown.ok) return { baseline: { raw: shown.out, revision: sha, source: 'merge-base' }, blocked: [] };
        tried.push(`merge base: ${rel} does not exist at ${sha.slice(0, 12)} (${ref})`);
      }
    }
  } else tried.push('merge base: the head spec is not a local file');
  // 3. CI artifact: no artifact store is configured in this version.
  tried.push('CI artifact: none configured');
  // 4. Snapshot: usable only with metadata, which arrives with case IDs (implementation step 3).
  const snap = o.testsDir ? [join(o.testsDir, '_support', 'openapi.snapshot.ts'), join(o.testsDir, '_support', 'openapi_snapshot.json')].find((f) => existsSync(f)) : undefined;
  tried.push(snap ? `snapshot: ${snap.replace(/\\/g, '/')} has no metadata (generatorVersion, specHash, source, capturedRevision)` : 'snapshot: none found');
  return {
    blocked: [{ code: 'BASE_SPEC_MISSING', reason: `No baseline spec to compare with. Tried: ${tried.join('; ')}. Pass --base <file>.` }],
  };
}

/** A readable revision for the head spec: the commit when the file is committed and unchanged, else the path / URL. */
export async function headRevision(head: string): Promise<string> {
  if (isUrl(head) || !existsSync(head)) return head;
  const dir = dirname(resolve(head));
  const sha = await git(dir, ['rev-parse', 'HEAD']);
  const dirty = await git(dir, ['status', '--porcelain', '--', resolve(head)]);
  if (sha.ok && dirty.ok && !dirty.out.trim()) return sha.out.trim();
  return head.replace(/\\/g, '/') + (sha.ok ? ` (working tree on ${sha.out.trim().slice(0, 12)})` : '');
}
