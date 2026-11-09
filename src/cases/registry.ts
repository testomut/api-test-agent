import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { normalizePath, operationUid } from '../change/normalize.js';
import { CASE_RULE_VOCABULARY_VERSION } from './ids.js';
import type { CaseRecord, ScenarioDefinition } from './assign.js';

/**
 * _support/cases.json: the registry of stable operationUids, case IDs and scenario definitions
 * (docs/OPENAPI_CHANGE_TRIGGER.md, "Case registry and generation manifest"). It keeps identity across
 * generations: entries are never recomputed or deleted; a removed operation becomes a tombstone.
 */

export interface OperationEntry {
  method: string;
  path: string;
  normalizedPath: string;
  operationId?: string;
  externalId?: string;
  status?: 'retired';
  retiredRevision?: string;
  retiredSpecHash?: string;
  lastValidatedGeneratorVersion?: string;
}

export interface CaseEntry {
  subjectUid: string;
  suiteType: string;
  polarity: string;
  location: string;
  rule: string;
  covers?: string[];
  relatedOperationUids?: string[];
  status?: 'retired';
}

export interface Registry {
  schemaVersion: 1;
  caseRuleVocabularyVersion: number;
  operations: Record<string, OperationEntry>;
  cases: Record<string, CaseEntry>;
  scenarios: Record<string, ScenarioDefinition & { status?: 'retired' }>;
  externalIdAliases: Record<string, string>;
  externalScenarioIdAliases: Record<string, string>;
}

export const emptyRegistry = (): Registry => ({
  schemaVersion: 1,
  caseRuleVocabularyVersion: CASE_RULE_VOCABULARY_VERSION,
  operations: {},
  cases: {},
  scenarios: {},
  externalIdAliases: {},
  externalScenarioIdAliases: {},
});

export async function readRegistry(file: string): Promise<Registry | undefined> {
  if (!existsSync(file)) return undefined;
  return { ...emptyRegistry(), ...JSON.parse(await readFile(file, 'utf8')) };
}

const ROLE_ORDER = ['create', 'read', 'update', 'delete'];
/** Arrays whose order carries no meaning: sorted. Scenario steps keep their order. */
const SORTED_ARRAYS = new Set(['covers', 'relatedOperationUids']);

/** Canonical JSON: sorted keys (CRUD roles keep create/read/update/delete), 2 spaces, LF, trailing newline. */
export function canonicalJson(value: unknown): string {
  const norm = (v: any, key?: string): any => {
    if (Array.isArray(v)) {
      const items = v.map((x) => norm(x));
      return key && SORTED_ARRAYS.has(key) ? [...items].sort() : items;
    }
    if (!v || typeof v !== 'object') return v;
    const keys = key === 'roles' ? ROLE_ORDER.filter((k) => k in v) : Object.keys(v).sort();
    return Object.fromEntries(keys.filter((k) => v[k] !== undefined).map((k) => [k, norm(v[k], k)]));
  };
  return JSON.stringify(norm(value), null, 2) + '\n';
}

/** Canonical file hash: SHA-256 over UTF-8 content with line endings normalized to LF (shared by generation and validation). */
export const fileHash = (content: string | Buffer) =>
  createHash('sha256').update(Buffer.from(String(content).replace(/^﻿/, '').replace(/\r\n?/g, '\n'), 'utf8')).digest('hex');

export interface SpecOperation {
  key: string;
  method: string;
  path: string;
  operationId?: string;
  externalId?: string;
}

/**
 * operationUid per spec operation. Priority: external ID (x-api-test-agent-id) of a registry entry, then an active
 * registry entry with the same method + normalized path, then the deterministic hash (lengthened on a collision).
 */
export function resolveOperationUids(ops: SpecOperation[], registry: Registry | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const entries = Object.entries(registry?.operations ?? {});
  const aliases = registry?.externalIdAliases ?? {};
  const canonicalExt = (id: string) => {
    const seen = new Set<string>();
    let cur = id;
    while (aliases[cur] && !seen.has(cur)) {
      seen.add(cur);
      cur = aliases[cur];
    }
    return cur;
  };
  const taken = new Set(entries.map(([uid]) => uid));
  const fresh: SpecOperation[] = [];
  for (const op of ops) {
    const np = normalizePath(op.path);
    const byExt = op.externalId ? entries.find(([, e]) => e.externalId && canonicalExt(e.externalId) === canonicalExt(op.externalId!) && e.status !== 'retired') : undefined;
    const byPath = entries.find(([, e]) => e.status !== 'retired' && e.method === op.method.toUpperCase() && e.normalizedPath === np);
    const hit = byExt ?? byPath;
    if (hit) out.set(op.key, hit[0]);
    else fresh.push(op);
  }
  // New operations: the hash, never an ID already in the registry (a retired one included).
  for (let length = 12; length <= 52; length += 4) {
    const uids = fresh.map((op) => operationUid(op.method, normalizePath(op.path), length));
    const clash = uids.some((u, i) => taken.has(u) || uids.indexOf(u) !== i);
    if (clash && length < 52) continue;
    fresh.forEach((op, i) => out.set(op.key, uids[i]));
    break;
  }
  return out;
}

export interface BuildInput {
  previous?: Registry;
  ops: SpecOperation[];
  uids: Map<string, string>;
  cases: CaseRecord[];
  scenarios: Record<string, ScenarioDefinition>;
  spec: { hash: string; revision: string };
  generatorVersion: string;
}

/** The next registry: previous entries kept, current operations / cases / scenarios added or refreshed, removed operations retired. */
export function buildRegistry(i: BuildInput): Registry {
  const reg: Registry = i.previous ? structuredClone(i.previous) : emptyRegistry();
  reg.schemaVersion = 1;
  reg.caseRuleVocabularyVersion = CASE_RULE_VOCABULARY_VERSION;
  const active = new Set<string>();
  for (const op of i.ops) {
    const uid = i.uids.get(op.key)!;
    active.add(uid);
    const prev = reg.operations[uid];
    reg.operations[uid] = {
      method: op.method.toUpperCase(),
      path: op.path,
      normalizedPath: normalizePath(op.path),
      ...(op.operationId ? { operationId: op.operationId } : {}),
      ...(op.externalId ?? prev?.externalId ? { externalId: op.externalId ?? prev?.externalId } : {}),
    };
  }
  for (const [uid, e] of Object.entries(reg.operations)) {
    if (active.has(uid) || e.status === 'retired') continue;
    reg.operations[uid] = { ...e, status: 'retired', retiredRevision: i.spec.revision, retiredSpecHash: i.spec.hash, lastValidatedGeneratorVersion: i.generatorVersion };
  }
  for (const c of i.cases) {
    const { caseId: id, ...rest } = c;
    reg.cases[id] = { ...rest };
  }
  for (const [uid, def] of Object.entries(i.scenarios)) reg.scenarios[uid] = def;
  return reg;
}
