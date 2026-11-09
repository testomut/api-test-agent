import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenApiChange, OpenApiChangeSet } from './types.js';

const show = (v: unknown) => {
  if (v === undefined) return '—';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return '`' + (s.length > 80 ? s.slice(0, 77) + '…' : s).replace(/\|/g, '\\|').replace(/`/g, "'") + '`';
};

const row = (c: OpenApiChange) =>
  `| \`${c.operationKey}\` | ${c.kind}${c.facet ? ` · ${c.facet}` : ''}${c.review ? ' · **review**' : ''} | ${c.scope ?? ''} | ${c.pointer ? `\`${c.pointer}\`` : ''} | ${show(c.before)} → ${show(c.after)} | ${c.breaking} | ${c.testRelevant ? 'yes' : 'no'} | ${c.note ?? (c.confidence !== undefined ? `confidence ${c.confidence}` : '')} |`;

export function toMarkdown(set: OpenApiChangeSet): string {
  const L: string[] = ['# OpenAPI changes', ''];
  L.push(`- Base: \`${set.baseRevision}\`${set.baseSource ? ` (${set.baseSource})` : ''}`);
  L.push(`- Head: \`${set.headRevision}\``);
  L.push(`- Engine: oasdiff ${set.engine.version}${set.engine.versionMismatch ? ' ⚠️ not the supported version' : ''}`, '');
  const main = set.changes.filter((c) => c.kind !== 'example-changed' && c.kind !== 'servers-changed');
  const examples = set.changes.filter((c) => c.kind === 'example-changed');
  const servers = set.changes.filter((c) => c.kind === 'servers-changed');
  const relevant = set.changes.filter((c) => c.testRelevant);
  if (set.blocked.length) {
    L.push('## ⛔ Blocked', '', '| Code | Reason | Pointers |', '|---|---|---|');
    for (const b of set.blocked) L.push(`| ${b.code} | ${b.reason.replace(/\|/g, '\\|')} | ${(b.pointers ?? []).map((p) => `\`${p}\``).join('<br>')} |`);
    L.push('');
  }
  if (!relevant.length && !set.blocked.length) L.push('No test-relevant changes found.', '');
  const head = ['| Operation | Change | Scope | Pointer | Before → After | Breaking | Test-relevant | Note |', '|---|---|---|---|---|---|---|---|'];
  if (main.length) {
    const yes = main.filter((c) => c.breaking === 'yes').length;
    const unknown = main.filter((c) => c.breaking === 'unknown').length;
    L.push(`## Changes (${main.length}: ${yes} breaking, ${unknown} unknown)`, '', ...head, ...main.map(row), '');
  }
  if (examples.length) L.push('## Example and default changes', '', 'Non-breaking, but the generator uses these values as payloads.', '', ...head, ...examples.map(row), '');
  if (servers.length) L.push('## Servers', '', 'Reported only; never regenerates cases.', '', ...head, ...servers.map(row), '');
  return L.join('\n') + '\n';
}

/** changes.json always (the machine-readable contract); changes.md as well with --format markdown. */
export async function writeChangeReport(set: OpenApiChangeSet, out: string, format: 'json' | 'markdown'): Promise<string[]> {
  await mkdir(out, { recursive: true });
  const files = [join(out, 'changes.json')];
  await writeFile(files[0], JSON.stringify(set, null, 2) + '\n');
  if (format === 'markdown') {
    files.push(join(out, 'changes.md'));
    await writeFile(files[1], toMarkdown(set));
  }
  return files;
}
