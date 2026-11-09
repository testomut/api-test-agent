import type { Operation } from '../types.js';
import type { CrudChain } from '../generate/graph.js';
import type { NegCase } from '../generate/negative.js';
import { bodyPointer, caseId, location, scenarioUid, type CaseParts, type Phase, type ScenarioStep } from './ids.js';

/**
 * Case IDs of the tests the generator writes for one operation (docs/OPENAPI_CHANGE_TRIGGER.md, "Stable IDs").
 * One physical test has one primary case ID; extra contract checks a test makes are listed in `covers`.
 */

export interface CaseRecord extends CaseParts {
  caseId: string;
  covers?: string[];
  relatedOperationUids?: string[];
}

export interface ScenarioDefinition {
  scenarioType: 'crud' | 'business';
  primaryOperationUid: string;
  steps: ScenarioStep[];
  roles?: { create: string | null; read: string | null; update: string | null; delete: string | null };
  externalId?: string;
}

export interface SuiteCaseIds {
  /** `variants`: one case per documented query value, in the order of `AssignInput.queryVariants`. */
  functional: { success?: string; notFound?: string; unauthorized?: string; variants: string[] };
  contract: { success?: string; notFound?: string; unauthorized?: string; body: string[]; query: string[] };
  scenario: { createRead?: string; updateRead?: string; deleteGone?: string };
  /** Every case of this operation, by suite, with metadata for cases.json. */
  records: Record<'functional' | 'contract' | 'scenario', CaseRecord[]>;
  scenarios: Record<string, ScenarioDefinition>;
}

const successStatus = (op: Operation) => op.responses.find((r) => /^2\d\d$/.test(r.status));

export interface AssignInput {
  op: Operation;
  chain?: CrudChain;
  positive: boolean;
  bodyCases: NegCase[];
  queryCases: NegCase[];
  notFound?: { param: string };
  unauthorized: boolean;
  scenarios: { createRead: boolean; updateRead: boolean; deleteGone: boolean };
  /** Documented query values the suite sends one by one (functional positive), each its own physical test. */
  queryVariants?: { name: string; value: string | number | boolean }[];
}

export function assignCaseIds(s: AssignInput, uidOf: (op: Operation) => string): SuiteCaseIds {
  const uid = uidOf(s.op);
  const records: SuiteCaseIds['records'] = { functional: [], contract: [], scenario: [] };
  const scenarios: SuiteCaseIds['scenarios'] = {};
  const chain = s.chain;
  // Precondition (create) and cleanup (delete) calls of a single-operation test: related, never the subject.
  const related = chain ? [chain.create, chain.delete].filter((o): o is Operation => !!o && o !== s.op).map(uidOf) : [];
  const add = (suite: 'functional' | 'contract' | 'scenario', p: Omit<CaseParts, 'suiteType'>, extra: Partial<CaseRecord> = {}) => {
    const parts: CaseParts = { ...p, suiteType: suite };
    const id = caseId(parts);
    if (!records[suite].some((r) => r.caseId === id)) records[suite].push({ ...parts, caseId: id, ...extra });
    return id;
  };
  const ok = successStatus(s.op);
  const ids: SuiteCaseIds = { functional: { variants: [] }, contract: { body: [], query: [] }, scenario: {}, records, scenarios };
  const rel = related.length ? { relatedOperationUids: related } : {};

  if (s.positive) {
    ids.functional.success = add('functional', { subjectUid: uid, polarity: 'positive', location: location.operation(), rule: 'documented-success' }, rel);
    if (ok?.contentTypes.length) {
      // A documented body: the schema is the primary check; status and content type are covered by the same test.
      const covers = [`contract:positive:${location.status(ok.status)}:documented`, ...ok.contentTypes.map((ct) => `contract:positive:${location.responseContentType(ct.split(';')[0].trim())}:documented`)];
      ids.contract.success = add('contract', { subjectUid: uid, polarity: 'positive', location: location.responseBody(''), rule: 'schema' }, { ...rel, covers });
    } else {
      // No body documented for the success response: what the test checks is that the status is documented.
      ids.contract.success = add('contract', { subjectUid: uid, polarity: 'positive', location: location.status(ok?.status ?? '200'), rule: 'documented' }, rel);
    }
  }
  for (const v of s.queryVariants ?? []) {
    ids.functional.variants.push(add('functional', { subjectUid: uid, polarity: 'positive', location: location.paramValue('query', v.name, v.value), rule: 'accepted-value' }));
  }
  if (s.notFound) {
    ids.functional.notFound = add('functional', { subjectUid: uid, polarity: 'negative', location: location.path(s.notFound.param), rule: 'not-found' });
    ids.contract.notFound = add('contract', { subjectUid: uid, polarity: 'positive', location: location.status('404'), rule: 'documented' });
  }
  if (s.unauthorized) {
    ids.functional.unauthorized = add('functional', { subjectUid: uid, polarity: 'negative', location: location.security(), rule: 'unauthorized' });
    ids.contract.unauthorized = add('contract', { subjectUid: uid, polarity: 'positive', location: location.status('401'), rule: 'documented' });
  }
  for (const c of s.bodyCases) {
    const t = c.target;
    ids.contract.body.push(t?.in === 'body' ? add('contract', { subjectUid: uid, polarity: 'negative', location: location.requestBody(bodyPointer(t.path)), rule: t.rule }) : '');
  }
  for (const c of s.queryCases) {
    const t = c.target;
    ids.contract.query.push(t?.in === 'query' && t.field ? add('contract', { subjectUid: uid, polarity: 'negative', location: location.query(t.field), rule: t.rule }) : '');
  }

  // CRUD scenarios: steps in order; the operation under test is the action.
  if (chain) {
    const step = (o: Operation | undefined, phase: Phase): ScenarioStep[] => (o ? [{ operationUid: uidOf(o), phase }] : []);
    const define = (steps: ScenarioStep[]) => {
      const inSteps = (o?: Operation) => (o && steps.some((x) => x.operationUid === uidOf(o)) ? uidOf(o) : null);
      const def: ScenarioDefinition = {
        scenarioType: 'crud',
        primaryOperationUid: uid,
        steps,
        roles: { create: inSteps(chain.create), read: inSteps(chain.read), update: inSteps(chain.update), delete: inSteps(chain.delete) },
      };
      const sUid = scenarioUid('crud', steps);
      scenarios[sUid] = def;
      return add('scenario', { subjectUid: sUid, polarity: 'positive', location: location.lifecycle(), rule: 'crud' }, { relatedOperationUids: [...new Set(steps.map((x) => x.operationUid).filter((u) => u !== uid))] });
    };
    if (s.scenarios.createRead) ids.scenario.createRead = define([...step(chain.create, 'action'), ...step(chain.read, 'assertion'), ...step(chain.delete, 'cleanup')]);
    if (s.scenarios.updateRead) ids.scenario.updateRead = define([...step(chain.create, 'setup'), ...step(s.op, 'action'), ...step(chain.read, 'assertion'), ...step(chain.delete, 'cleanup')]);
    if (s.scenarios.deleteGone) ids.scenario.deleteGone = define([...step(chain.create, 'setup'), ...step(s.op, 'action'), ...step(chain.read, 'assertion')]);
  }
  return ids;
}
