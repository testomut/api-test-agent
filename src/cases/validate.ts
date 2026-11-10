import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizePath, type NormOp, type NormSpec } from '../change/normalize.js';
import { CASE_RULE_VOCABULARY_VERSION, parseCaseId } from './ids.js';
import { canonicalJson, fileHash, type Registry } from './registry.js';
import { boundaryValues } from '../generate/boundaries.js';

/** `registry validate` / `manifest validate` (docs/OPENAPI_CHANGE_TRIGGER.md, "Registry validation"). */

export interface Finding {
  code: string;
  pointer: string;
  reason: string;
}

export interface RegistryReport {
  syntaxValidation: 'passed' | 'failed';
  schemaValidation: 'passed' | 'failed' | 'not-run';
  errors: Finding[];
  blocked: Finding[];
}

const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
const UID_OP = /^op_[A-Z2-7]{12,52}$/;
const UID_SCN = /^scn_[A-Z2-7]{12,52}$/;
const PHASES = ['setup', 'action', 'assertion', 'cleanup'];

/** Syntax first (no spec needed); with a spec, the active entries are checked against it. */
export function validateRegistry(text: string, spec?: NormSpec): RegistryReport {
  const errors: Finding[] = [];
  const blocked: Finding[] = [];
  const err = (code: string, pointer: string, reason: string) => errors.push({ code, pointer, reason });
  let reg: Registry;
  try {
    reg = JSON.parse(text);
  } catch (e: any) {
    return { syntaxValidation: 'failed', schemaValidation: spec ? 'failed' : 'not-run', errors: [{ code: 'INVALID_REGISTRY_JSON', pointer: '', reason: e?.message ?? String(e) }], blocked };
  }
  if (reg?.schemaVersion !== 1) err('INVALID_REGISTRY_SCHEMA', '/schemaVersion', 'schemaVersion must be 1');
  if (reg?.caseRuleVocabularyVersion === undefined) err('INVALID_REGISTRY_SCHEMA', '/caseRuleVocabularyVersion', 'missing: a legacy registry (vocabulary 0) needs a migration');
  else if (reg.caseRuleVocabularyVersion > CASE_RULE_VOCABULARY_VERSION) {
    blocked.push({ code: 'UNSUPPORTED_CASE_RULE_VOCABULARY', pointer: '/caseRuleVocabularyVersion', reason: `vocabulary ${reg.caseRuleVocabularyVersion} is newer than the supported ${CASE_RULE_VOCABULARY_VERSION}` });
  }
  for (const k of ['operations', 'cases', 'scenarios', 'externalIdAliases', 'externalScenarioIdAliases'] as const) {
    if (!reg?.[k] || typeof reg[k] !== 'object' || Array.isArray(reg[k])) err('INVALID_REGISTRY_SCHEMA', `/${k}`, `${k} must be an object`);
  }
  if (errors.length) return { syntaxValidation: 'failed', schemaValidation: spec ? 'failed' : 'not-run', errors, blocked };
  if (canonicalJson(reg) !== text.replace(/\r\n/g, '\n')) err('NON_CANONICAL_REGISTRY', '', 'not in canonical form (sorted keys, 2 spaces, LF, trailing newline): regenerate or rewrite it with the canonical writer');

  // Operations and tombstones.
  const activeIdentity = new Map<string, string>();
  const activeExt = new Map<string, string>();
  for (const [uid, e] of Object.entries(reg.operations)) {
    const p = `/operations/${esc(uid)}`;
    if (!UID_OP.test(uid)) err('INVALID_OPERATION_UID', p, `"${uid}" is not op_ + 12–52 base32 characters`);
    if (!e?.method || !e?.path || !e?.normalizedPath) {
      err('INVALID_OPERATION_ENTRY', p, 'method, path and normalizedPath are required');
      continue;
    }
    if (normalizePath(e.path) !== e.normalizedPath) err('INVALID_OPERATION_ENTRY', `${p}/normalizedPath`, `"${e.normalizedPath}" is not the normalized form of "${e.path}"`);
    if (e.status === 'retired') {
      for (const k of ['retiredRevision', 'retiredSpecHash', 'lastValidatedGeneratorVersion'] as const) if (!e[k]) err('INVALID_TOMBSTONE', `${p}/${k}`, `a retired entry keeps ${k}`);
      continue;
    }
    if (e.status !== undefined) err('INVALID_OPERATION_ENTRY', `${p}/status`, 'status is absent (active) or "retired"');
    const id = `${e.method} ${e.normalizedPath}`;
    if (activeIdentity.has(id)) err('DUPLICATE_ACTIVE_OPERATION', p, `${id} is also ${activeIdentity.get(id)}`);
    else activeIdentity.set(id, uid);
    if (e.externalId) {
      if (activeExt.has(e.externalId)) err('DUPLICATE_API_TEST_AGENT_ID', `${p}/externalId`, `"${e.externalId}" is also used by ${activeExt.get(e.externalId)}`);
      else activeExt.set(e.externalId, uid);
    }
  }
  // Aliases: no cycles.
  for (const [name, map] of [['externalIdAliases', reg.externalIdAliases], ['externalScenarioIdAliases', reg.externalScenarioIdAliases]] as const) {
    for (const start of Object.keys(map)) {
      const seen = new Set<string>([start]);
      let cur = map[start];
      while (cur !== undefined && map[cur] !== undefined) {
        if (seen.has(cur)) {
          err('ALIAS_CYCLE', `/${name}/${esc(start)}`, `alias cycle through "${cur}"`);
          break;
        }
        seen.add(cur);
        cur = map[cur];
      }
    }
  }
  // Scenarios.
  const scnExt = new Map<string, string>();
  for (const [uid, def] of Object.entries(reg.scenarios)) {
    const p = `/scenarios/${esc(uid)}`;
    if (!UID_SCN.test(uid)) err('INVALID_SCENARIO_UID', p, `"${uid}" is not scn_ + 12–52 base32 characters`);
    const steps = Array.isArray(def?.steps) ? def.steps : [];
    if (steps.length < 2) err('INVALID_SCENARIO', `${p}/steps`, 'a scenario has at least two steps');
    steps.forEach((s, i) => {
      if (!PHASES.includes(s?.phase)) err('INVALID_SCENARIO', `${p}/steps/${i}/phase`, `phase must be one of ${PHASES.join(', ')}`);
      if (!reg.operations[s?.operationUid]) err('INVALID_SCENARIO', `${p}/steps/${i}/operationUid`, `${s?.operationUid} is not in operations`);
    });
    if (!steps.some((s) => s.operationUid === def.primaryOperationUid)) err('INVALID_SCENARIO', `${p}/primaryOperationUid`, 'the primary operation must appear in steps');
    if (def.scenarioType !== 'crud' && def.scenarioType !== 'business') err('INVALID_SCENARIO', `${p}/scenarioType`, 'scenarioType is crud or business');
    if (def.roles && def.scenarioType !== 'crud') err('INVALID_SCENARIO', `${p}/roles`, 'roles are allowed only on crud scenarios');
    for (const [role, u] of Object.entries(def.roles ?? {})) if (u !== null && !steps.some((s) => s.operationUid === u)) err('INVALID_SCENARIO', `${p}/roles/${role}`, `${u} is not in steps`);
    if (def.externalId) {
      if (scnExt.has(def.externalId)) err('DUPLICATE_EXTERNAL_SCENARIO_ID', `${p}/externalId`, `"${def.externalId}" is also used by ${scnExt.get(def.externalId)}`);
      else scnExt.set(def.externalId, uid);
    }
  }
  // Cases: ID grammar, vocabulary, combination, entry ↔ ID, references.
  for (const [id, c] of Object.entries(reg.cases)) {
    const p = `/cases/${esc(id)}`;
    const parsed = parseCaseId(id);
    if (!parsed.ok) {
      err(parsed.error.code, p, parsed.error.reason);
      continue;
    }
    for (const k of ['subjectUid', 'suiteType', 'polarity', 'location', 'rule'] as const) {
      if (c?.[k] !== parsed.parts[k]) err('CASE_ENTRY_MISMATCH', `${p}/${k}`, `"${c?.[k]}" does not match the case ID ("${parsed.parts[k]}")`);
    }
    const subject = parsed.parts.subjectUid;
    if (subject.startsWith('op_') ? !reg.operations[subject] : !reg.scenarios[subject]) err('CASE_SUBJECT_NOT_FOUND', `${p}/subjectUid`, `${subject} is not in the registry`);
    for (const u of c.relatedOperationUids ?? []) if (!reg.operations[u]) err('CASE_SUBJECT_NOT_FOUND', `${p}/relatedOperationUids`, `${u} is not in operations`);
    for (const cover of c.covers ?? []) {
      const r = parseCaseId(`ata:${subject}:${cover}`);
      if (!r.ok) err(r.error.code, `${p}/covers`, `covers "${cover}": ${r.error.reason}`);
    }
  }
  const syntaxValidation = errors.length ? 'failed' : 'passed';
  if (!spec) return { syntaxValidation, schemaValidation: 'not-run', errors, blocked };

  // Semantics: active entries against the given spec.
  const before = errors.length;
  const specOp = new Map(spec.ops.map((o) => [`${o.method} ${o.normalizedPath}`, o]));
  const opOf = new Map<string, NormOp>();
  for (const [uid, e] of Object.entries(reg.operations)) {
    if (e.status === 'retired') continue;
    const o = specOp.get(`${e.method} ${e.normalizedPath}`);
    if (!o) err('ACTIVE_OPERATION_NOT_FOUND', `/operations/${esc(uid)}`, `${e.method} ${e.path} is not in the spec`);
    else opOf.set(uid, o);
  }
  for (const [id, c] of Object.entries(reg.cases)) {
    const o = opOf.get(c.subjectUid);
    if (!o || c.status === 'retired') continue;
    const f = checkLocation(o, c.location, c.rule);
    if (f) (f.code === 'CASE_LOCATION_UNRESOLVED' ? blocked : errors).push({ ...f, pointer: `/cases/${esc(id)}` });
  }
  return { syntaxValidation, schemaValidation: errors.length > before ? 'failed' : 'passed', errors, blocked };
}

/** Percent-decoding of a canonical segment, then RFC 6901 unescaping. A bare "*" is the array wildcard. */
function decodeSegment(seg: string): string | typeof WILDCARD {
  if (seg === '*') return WILDCARD;
  return decodeURIComponent(seg).replace(/~1/g, '/').replace(/~0/g, '~');
}
const WILDCARD = Symbol('*');

const STRING_RULES = ['minLength', 'maxLength', 'pattern', 'format'];
const NUMBER_RULES = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
const ARRAY_RULES = ['minItems', 'maxItems', 'uniqueItems'];
const OBJECT_RULES = ['minProperties', 'maxProperties', 'additionalProperties'];
const typesOf = (s: any): string[] => (s?.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]);

function ruleFits(schema: any, rule: string): boolean {
  const t = typesOf(schema);
  if (!t.length) return true; // no type: nothing to contradict
  if (STRING_RULES.includes(rule)) return t.includes('string');
  if (NUMBER_RULES.includes(rule)) return t.includes('number') || t.includes('integer');
  if (ARRAY_RULES.includes(rule)) return t.includes('array');
  if (OBJECT_RULES.includes(rule)) return t.includes('object');
  return true;
}

function walk(schema: any, pointer: string): { node?: any; error?: Finding } {
  let node = schema;
  for (const raw of pointer.split('/').slice(1)) {
    if (!node || node.$recursive || node.oneOf || node.anyOf) return { error: { code: 'CASE_LOCATION_UNRESOLVED', pointer: '', reason: `cannot follow "${pointer}" through a recursive or polymorphic schema` } };
    const seg = decodeSegment(raw);
    if (seg === WILDCARD) {
      if (!typesOf(node).includes('array') && !node.items) return { error: { code: 'INVALID_ARRAY_WILDCARD', pointer: '', reason: `"*" in "${pointer}" does not go through an array` } };
      node = node.items;
    } else {
      node = node.properties?.[seg];
      if (node === undefined) return { error: { code: 'INVALID_CASE_LOCATION', pointer: '', reason: `"${seg}" in "${pointer}" is not a property` } };
    }
  }
  return { node };
}

function checkLocation(o: NormOp, loc: string, rule: string): Finding | undefined {
  const bad = (reason: string): Finding => ({ code: 'INVALID_CASE_LOCATION', pointer: '', reason: `${o.key}: ${reason}` });
  const m = loc.match(/^request\.(query|path|header|cookie)#\/(.*)$/);
  if (m) {
    const [rawName, rawValue] = m[2].split('/');
    const name = String(decodeSegment(rawName));
    const p = o.params.find((x) => x.in === m[1] && (m[1] === 'header' ? x.name.toLowerCase() === name : x.name === name));
    if (!p) return bad(`no ${m[1]} parameter "${name}"`);
    if (rawValue !== undefined) {
      // accepted-value: the value must be one the spec documents for this parameter.
      const value = String(decodeSegment(rawValue));
      // sort: the value comes from the reviewed collection mapping; the spec can only rule it out with an enum.
      if (rule === 'sort' && !Array.isArray(p.schema?.enum) && p.schema?.const === undefined) return undefined;
      const allowed = Array.isArray(p.schema?.enum) ? p.schema.enum.map(String) : p.schema?.const !== undefined ? [String(p.schema.const)] : boundaryValues(p.schema).map(String);
      return allowed.includes(value) ? undefined : bad(`"${value}" is not a documented value or valid limit of ${m[1]} "${name}"`);
    }
    if (!['required', 'not-found', 'filter', 'pagination'].includes(rule) && !ruleFits(p.schema, rule)) return { code: 'INVALID_CASE_RULE_FOR_SCHEMA', pointer: '', reason: `${o.key}: "${rule}" does not apply to ${m[1]} "${name}"` };
    return undefined;
  }
  const status = loc.match(/^response\.status#\/(.+)$/);
  if (status) return o.responses[String(decodeSegment(status[1]))] ? undefined : bad(`no documented response ${status[1]}`);
  const ct = loc.match(/^response\.content-type#\/(.+)$/);
  if (ct) {
    const mt = String(decodeSegment(ct[1]));
    return Object.values(o.responses).some((r) => mt in r.content) ? undefined : bad(`no response with media type ${mt}`);
  }
  const body = loc.match(/^(request|response)\.body#(.*)$/);
  if (body) {
    const schemas = body[1] === 'request' ? Object.values(o.requestBody?.content ?? {}) : Object.values(o.responses).flatMap((r) => Object.values(r.content));
    if (!schemas.length) return bad(`no ${body[1]} body`);
    let last: Finding | undefined;
    for (const s of schemas) {
      if (rule === 'required' && body[2]) {
        // "required" names the field: its parent must list it, or at least have it.
        const parent = walk(s, body[2].split('/').slice(0, -1).join('/'));
        if (parent.error) return parent.error.code === 'CASE_LOCATION_UNRESOLVED' ? parent.error : { ...parent.error, reason: `${o.key}: ${parent.error.reason}` };
        const leaf = String(decodeSegment(body[2].split('/').pop()!));
        if (parent.node?.properties?.[leaf] !== undefined) return undefined;
        last = bad(`"${leaf}" is not a property`);
        continue;
      }
      if (rule === 'variant') {
        // request.body#<pointer>/@<n>: branch n of a oneOf / anyOf at <pointer>.
        const m = /^(.*)\/@(\d+)$/.exec(body[2]);
        const at = m ? walk(s, m[1]) : { error: { code: 'INVALID_CASE_LOCATION', pointer: '', reason: `"${body[2]}" does not end with /@<branch>` } as Finding };
        if (at.error) {
          last = at.error.code === 'CASE_LOCATION_UNRESOLVED' ? at.error : { ...at.error, reason: `${o.key}: ${at.error.reason}` };
          continue;
        }
        const branches = (at.node?.oneOf ?? at.node?.anyOf) as unknown[] | undefined;
        if (Array.isArray(branches) && Number(m![2]) < branches.length) return undefined;
        last = bad(`no oneOf / anyOf branch ${m![2]} at ${body[1]} body ${m![1] || '(root)'}`);
        continue;
      }
      const r = walk(s, body[2]);
      if (r.error) {
        last = r.error.code === 'CASE_LOCATION_UNRESOLVED' ? r.error : { ...r.error, reason: `${o.key}: ${r.error.reason}` };
        continue;
      }
      if (!['schema', 'type', 'required', 'nullable', 'enum', 'const', 'unique', 'optional-omitted'].includes(rule) && !ruleFits(r.node, rule)) {
        last = { code: 'INVALID_CASE_RULE_FOR_SCHEMA', pointer: '', reason: `${o.key}: "${rule}" does not apply to ${body[1]} body ${body[2] || '(root)'}` };
        continue;
      }
      return undefined;
    }
    return last;
  }
  return undefined; // operation, lifecycle, request.security, request.content-type: nothing to resolve
}

export interface ManifestReport {
  files: number;
  findings: Finding[];
}

/** Working files against the trusted hashes; a mismatch is never accepted as a new baseline. */
export async function validateManifest(testsDir: string): Promise<ManifestReport> {
  const file = join(testsDir, '_support', 'generation-manifest.json');
  if (!existsSync(file)) return { files: 0, findings: [{ code: 'MANIFEST_MISSING', pointer: '', reason: `${file} not found: generate the suite first` }] };
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const findings: Finding[] = [];
  for (const [rel, entry] of Object.entries<any>(manifest.files ?? {})) {
    if (entry.ownership === 'hand-written') continue;
    const path = join(testsDir, rel);
    const p = `/files/${esc(rel)}`;
    if (!existsSync(path)) {
      findings.push({ code: 'GENERATED_FILE_MISSING', pointer: p, reason: `${rel} is listed but missing` });
      continue;
    }
    if (fileHash(await readFile(path, 'utf8')) !== entry.sha256) {
      findings.push({ code: 'GENERATED_FILE_MODIFIED', pointer: p, reason: `${rel} differs from the generated content (ownership: generated-modified); it will not be overwritten automatically` });
    }
  }
  const registry = join(dirname(file), 'cases.json');
  if (manifest.caseRegistryHash && existsSync(registry) && fileHash(await readFile(registry, 'utf8')) !== manifest.caseRegistryHash) {
    findings.push({ code: 'CASE_REGISTRY_CHANGED', pointer: '/caseRegistryHash', reason: 'cases.json changed since generation: run `registry validate`' });
  }
  return { files: Object.keys(manifest.files ?? {}).length, findings };
}
