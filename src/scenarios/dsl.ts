import type { Operation } from '../types.js';
import type { CoverageGap } from '../generate/body-cases.js';

/**
 * Reviewed business scenarios (docs/SUPPORT_MATRIX.md, stage 8). Business flows are never guessed from paths:
 * they come from this file, written and reviewed by a human, validated strictly against the spec.
 * JSON Schema: schemas/scenarios.schema.json.
 */

export type Phase = 'setup' | 'action' | 'assertion' | 'cleanup';

export interface ScenarioStepDef {
  name?: string;
  operationId: string;
  phase: Phase;
  /** Path and query parameters by name. Strings may use "{var}" for values saved by earlier steps. */
  params?: Record<string, unknown>;
  /** JSON request body; "{var}" strings are replaced by saved values. */
  body?: unknown;
  /** The documented status this step must get ("201", "4XX"...). Optional for cleanup steps. */
  expect?: string;
  /** Values to keep for later steps: variable → JSON pointer into the response body. */
  save?: Record<string, string>;
}

export interface ScenarioDef {
  /** External stable ID: the scenarioUid comes from it (never from the title). */
  id: string;
  title: string;
  polarity: 'positive' | 'negative';
  /** The step under test: its name or operationId. Must be an action step. */
  primary: string;
  steps: ScenarioStepDef[];
}

export interface ScenarioFile {
  scenarios: ScenarioDef[];
}

export interface ResolvedStep extends ScenarioStepDef {
  op: Operation;
}

export interface ResolvedScenario extends Omit<ScenarioDef, 'steps'> {
  steps: ResolvedStep[];
  primaryOp: Operation;
}

const PHASES: Phase[] = ['setup', 'action', 'assertion', 'cleanup'];
const VAR = /\{([A-Za-z_][\w]*)\}/g;
const ID = /^[a-z0-9][a-z0-9._-]*$/;

/** Variables a value refers to ("{cartId}" anywhere inside strings). */
export function varsIn(value: unknown): string[] {
  if (typeof value === 'string') return [...value.matchAll(VAR)].map((m) => m[1]);
  if (Array.isArray(value)) return value.flatMap(varsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(varsIn);
  return [];
}

const documented = (op: Operation, status: string) => {
  const s = status.toUpperCase();
  return op.responses.some((r) => r.status.toUpperCase() === s || (/^\dXX$/.test(r.status.toUpperCase()) && r.status[0] === s[0]) || r.status === 'default');
};

/** Strict validation; every problem is an error with a pointer into the file. */
export function validateScenarios(file: unknown, ops: Operation[]): { errors: { pointer: string; reason: string }[]; scenarios: ResolvedScenario[] } {
  const errors: { pointer: string; reason: string }[] = [];
  const err = (pointer: string, reason: string) => errors.push({ pointer, reason });
  const out: ResolvedScenario[] = [];
  const f = file as ScenarioFile;
  if (!f || typeof f !== 'object' || !Array.isArray(f.scenarios)) {
    err('', 'a scenarios file is { "scenarios": [ … ] }');
    return { errors, scenarios: out };
  }
  const byId = new Map(ops.filter((o) => o.operationId).map((o) => [o.operationId!, o]));
  const ids = new Set<string>();
  f.scenarios.forEach((sc, i) => {
    const p = `/scenarios/${i}`;
    const before = errors.length;
    for (const k of Object.keys(sc ?? {})) if (!['id', 'title', 'polarity', 'primary', 'steps'].includes(k)) err(`${p}/${k}`, `unknown field "${k}"`);
    if (typeof sc?.id !== 'string' || !ID.test(sc.id)) err(`${p}/id`, 'id is a stable external ID: lowercase letters, digits, ".", "_", "-"');
    else if (ids.has(sc.id)) err(`${p}/id`, `duplicate id "${sc.id}" (DUPLICATE_EXTERNAL_SCENARIO_ID)`);
    else ids.add(sc.id);
    if (typeof sc?.title !== 'string' || !sc.title.trim()) err(`${p}/title`, 'title is required');
    if (sc?.polarity !== 'positive' && sc?.polarity !== 'negative') err(`${p}/polarity`, 'polarity is "positive" or "negative"');
    const steps = Array.isArray(sc?.steps) ? sc.steps : [];
    if (steps.length < 2) err(`${p}/steps`, 'a scenario has at least two steps');
    const saved = new Set<string>();
    const resolved: ResolvedStep[] = [];
    let seenCleanup = false;
    steps.forEach((st, j) => {
      const sp = `${p}/steps/${j}`;
      for (const k of Object.keys(st ?? {})) if (!['name', 'operationId', 'phase', 'params', 'body', 'expect', 'save'].includes(k)) err(`${sp}/${k}`, `unknown field "${k}"`);
      const op = byId.get(st?.operationId);
      if (!op) {
        err(`${sp}/operationId`, `operation "${st?.operationId}" is not in the spec`);
        return;
      }
      if (!PHASES.includes(st.phase)) err(`${sp}/phase`, `phase is one of ${PHASES.join(', ')}`);
      if (st.phase === 'cleanup') seenCleanup = true;
      else if (seenCleanup) err(`${sp}/phase`, 'cleanup steps come last');
      if (st.expect === undefined && st.phase !== 'cleanup') err(`${sp}/expect`, 'every step but cleanup names its expected status');
      if (st.expect !== undefined && !documented(op, String(st.expect))) err(`${sp}/expect`, `${st.expect} is not documented for ${op.key}`);
      for (const v of varsIn([st.params, st.body])) if (!saved.has(v)) err(sp, `"{${v}}" is not saved by an earlier step`);
      for (const name of op.params.filter((x) => x.in === 'path').map((x) => x.name)) {
        if (!(name in (st.params ?? {})) && op.params.find((x) => x.name === name)?.knownValue === undefined) err(`${sp}/params`, `path parameter "${name}" has no value`);
      }
      for (const name of Object.keys(st.params ?? {})) if (!op.params.some((x) => x.name === name && (x.in === 'path' || x.in === 'query'))) err(`${sp}/params/${name}`, `${op.key} has no path or query parameter "${name}"`);
      if (st.body !== undefined && !op.hasRequestBody) err(`${sp}/body`, `${op.key} has no request body`);
      for (const [v, ptr] of Object.entries(st.save ?? {})) {
        if (typeof ptr !== 'string' || !(ptr === '' || ptr.startsWith('/'))) err(`${sp}/save/${v}`, 'save values are JSON pointers such as "/id"');
        saved.add(v);
      }
      resolved.push({ ...st, op });
    });
    // Data a scenario creates must be removed: any non-safe setup step needs a cleanup step.
    const writes = resolved.filter((s) => s.phase !== 'cleanup' && !['get', 'head', 'options'].includes(s.op.method));
    if (writes.length && !resolved.some((s) => s.phase === 'cleanup')) err(`${p}/steps`, 'the scenario writes data but has no cleanup step (MISSING_CLEANUP)');
    const primary = resolved.find((s) => s.name === sc?.primary) ?? resolved.find((s) => s.op.operationId === sc?.primary);
    if (!primary) err(`${p}/primary`, `primary "${sc?.primary}" is not a step name or operationId of this scenario`);
    else if (primary.phase !== 'action') err(`${p}/primary`, 'the primary step is the action under test (phase "action")');
    if (errors.length === before && primary) out.push({ ...sc, steps: resolved, primaryOp: primary.op });
  });
  return { errors, scenarios: out };
}

/** Coverage note for operations without any scenario: business flows need the reviewed file. */
export const NO_SCENARIO_FILE: CoverageGap = {
  code: 'UNCONFIRMED_BUSINESS_RULE',
  location: 'lifecycle',
  reason: 'business flows (state transitions, parent → child, idempotency, polling) need a reviewed scenarios file (--scenarios)',
};
