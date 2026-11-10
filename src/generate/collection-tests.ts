import type { OpenApiDoc } from '../spec/loader.js';
import type { CoverageGap } from './body-cases.js';
import { schemaAt, type ResolvedCollection } from './collection.js';

/**
 * Deep collection tests (strategies A and C). One plan feeds the TypeScript and Python renderers and the case IDs.
 *
 * Controlled datasets (strategy A, create & verify): when the resource can be created and cleaned up, a test creates
 * its own records carrying a unique marker in an isolating filter field and reads the collection through that filter.
 * Sorting, paging and uniqueness are then checked on known data (an empty or one-element page would hide the defect),
 * and nothing depends on other data on the target. Without creation the same checks run read-only (strategy C) on
 * existing data, and a test without enough data is skipped with the reason, never passed silently.
 */

export type CollectionTestKind = 'listed' | 'filter' | 'sort' | 'sort-reverse' | 'pagination' | 'unique' | 'total';
type Filter = { param: string; field: string; match: 'equals' | 'contains' | 'search' };

export interface CollectionTest {
  kind: CollectionTestKind;
  title: string;
  mode: 'controlled' | 'read-only';
  filter?: Filter;
  /** Controlled filter: the matching and the non-matching value ("marker" = derived from the run's unique marker). */
  filterValues?: { kind: 'marker' } | { kind: 'enum'; a: string | number; b: string | number };
  sort?: { param: string; value: string; field: string; order: 'asc' | 'desc' };
  /** sort-reverse: the descending counterpart of `sort` (same parameter and field). */
  sortDesc?: { param: string; value: string; field: string; order: 'asc' | 'desc' };
  /** Controlled sort: the sort-field values of the three records, in creation order (strings get the marker appended). */
  sortValues?: (string | number)[];
  unique?: string;
}

export interface CollectionPlan {
  c: ResolvedCollection;
  tests: CollectionTest[];
  /** The filter that isolates the test's own records (a unique marker), when one is settable on create. */
  iso?: Filter;
  /** create → listed → update → listed → delete → not listed, in the list operation's scenarios. */
  lifecycle: boolean;
  /** The update payload leaves the isolating field alone, so the lifecycle can keep reading through the filter. */
  lifecycleIso: boolean;
  gaps: CoverageGap[];
  /** Page size used to walk the whole collection (bounded by maxPages). */
  walkSize: number;
  /** Page size of the pagination test (its controlled dataset has pageSize + 1 records). */
  pageSize: number;
}

const typesOf = (s: any): string[] => (s?.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]);
/** A free-text string field that accepts the marker ("ata-" + 8 characters, plus a short suffix). */
const markerString = (s: any) => typesOf(s).includes('string') && !s.enum && s.const === undefined && !s.pattern && !s.format && (s.maxLength ?? Infinity) >= 20 && (s.minLength ?? 0) <= 12;

export function planCollectionTests(doc: OpenApiDoc, c: ResolvedCollection, x: { canCreate: boolean; createSchema?: any; canUpdate: boolean; updatePayload?: unknown; canDelete: boolean }): CollectionPlan {
  const gaps: CoverageGap[] = [];
  const tests: CollectionTest[] = [];
  const top = (ptr: string) => ptr.split('/').length === 2; // controlled data sets top-level fields only
  // "strategy": "read-only" in the reviewed mapping: nothing is created for these checks, even with a confirmed create.
  if (c.strategy === 'read-only') x = { ...x, canCreate: false, canUpdate: false, canDelete: false };
  const createField = (ptr: string) => (x.canCreate && x.createSchema && top(ptr) ? schemaAt(doc, x.createSchema, ptr) : undefined);
  const markerFilter = (f: Filter) => {
    const s = createField(f.field);
    if (!s) return false;
    return f.match === 'contains' ? typesOf(s).includes('array') && markerString(schemaAt(doc, s, '/*')) && (s.maxItems ?? 1) >= 1 : markerString(s);
  };
  const sortValuesOf = (field: string) => {
    const s = iso ? createField(field) : undefined;
    if (!s || s.enum) return undefined;
    if (typesOf(s).some((t) => t === 'integer' || t === 'number')) {
      const lo = typeof s.minimum === 'number' ? s.minimum + (s.exclusiveMinimum === true ? 1 : 0) : 1;
      return typeof s.maximum !== 'number' || s.maximum >= lo + 2 ? [lo + 2, lo, lo + 1] : undefined;
    }
    return markerString(s) ? ['sort-c-', 'sort-a-', 'sort-b-'] : undefined;
  };
  const filters = (c.filters ?? []).filter((f, i, all) => all.findIndex((g) => g.param === f.param) === i);
  const iso = filters.find(markerFilter);

  const fixed = c.page?.style === 'page' && c.page.sizeParam === undefined ? c.page.size : undefined;
  const limitParam = c.page?.style === 'offset' ? c.page.limitParam : c.page?.style === 'page' ? c.page.sizeParam : undefined;
  const limitSchema: any = limitParam ? c.op.params.find((p) => p.name === limitParam)?.schema : undefined;
  const minSize = typeof limitSchema?.minimum === 'number' ? limitSchema.minimum : 1;
  const maxSize = typeof limitSchema?.maximum === 'number' ? limitSchema.maximum : 50;
  // A fixed page size (no size parameter) is the only size there is, for walking and for the paging test.
  const walkSize = fixed ?? Math.max(minSize, Math.min(maxSize, 50));
  const pageSize = fixed ?? Math.min(Math.max(2, minSize), maxSize);

  if (x.canCreate) tests.push({ kind: 'listed', title: 'a created resource is listed with the fields it was created with', mode: 'controlled' });
  else gaps.push({ code: 'MISSING_CLEANUP', location: 'operation', reason: `${c.op.key}: membership of a created resource needs a confirmed create with cleanup (strategy A); only read-only checks run` });

  for (const f of filters) {
    const s = createField(f.field);
    let filterValues: CollectionTest['filterValues'];
    if (markerFilter(f)) filterValues = { kind: 'marker' };
    else if (iso && s && f.match === 'equals' && Array.isArray(s.enum) && s.enum.length >= 2) filterValues = { kind: 'enum', a: s.enum[0], b: s.enum[1] };
    tests.push({
      kind: 'filter',
      title: (filterValues ? `filter ${f.param} returns the matching resource and leaves out the other` : `filter ${f.param} returns only matching resources`) + (f.match === 'search' ? ' (search, ignoring case)' : ''),
      mode: filterValues ? 'controlled' : 'read-only',
      filter: f,
      ...(filterValues ? { filterValues } : {}),
    });
    if (!filterValues && x.canCreate) gaps.push({ code: 'CANNOT_ISOLATE_RULE', location: `request.query#/${f.param}`, reason: `filter ${f.param}: ${f.field} cannot be set to a value no other data has, so it is checked read-only on existing data` });
  }
  const sorts = (c.sorts ?? []).filter((v, i, all) => all.findIndex((w) => w.param === v.param && w.value === v.value) === i);
  for (const s of sorts) {
    const sortValues = sortValuesOf(s.field);
    tests.push({ kind: 'sort', title: `sort ${s.param}=${s.value} orders by ${s.field} ${s.order === 'asc' ? 'ascending' : 'descending'}`, mode: sortValues ? 'controlled' : 'read-only', sort: s, ...(sortValues ? { sortValues } : {}) });
  }
  // Ascending and descending on the same field: the descending order is the ascending one reversed.
  for (const asc of sorts.filter((s) => s.order === 'asc')) {
    const desc = sorts.find((s) => s.order === 'desc' && s.param === asc.param && s.field === asc.field);
    if (!desc) continue;
    const sortValues = sortValuesOf(asc.field);
    tests.push({ kind: 'sort-reverse', title: `sort ${asc.param}=${desc.value} is the reverse of ${asc.param}=${asc.value}`, mode: sortValues ? 'controlled' : 'read-only', sort: asc, sortDesc: desc, ...(sortValues ? { sortValues } : {}) });
  }
  if (c.page) {
    const controlled = !!iso && pageSize <= 5;
    tests.push({ kind: 'pagination', title: `pages of ${pageSize} have the requested size and never repeat a resource`, mode: controlled ? 'controlled' : 'read-only' });
  } else gaps.push({ code: 'UNCONFIRMED_BUSINESS_RULE', location: 'operation', reason: `${c.op.key}: no reviewed paging mapping ("page"): page size and cross-page duplicates are not checked` });
  for (const u of [...new Set(c.unique ?? [])]) tests.push({ kind: 'unique', title: `resources are unique by ${u}`, mode: iso ? 'controlled' : 'read-only', unique: u });
  if (c.total) tests.push({ kind: 'total', title: `${c.total} equals the number of resources and is the same on every page`, mode: iso ? 'controlled' : 'read-only' });
  else gaps.push({ code: 'UNCONFIRMED_BUSINESS_RULE', location: 'operation', reason: `${c.op.key}: no reviewed "total" pointer: the total count is not checked` });
  if (!iso && x.canCreate) gaps.push({ code: 'CANNOT_ISOLATE_RULE', location: 'operation', reason: `${c.op.key}: no filter can isolate the test's own records, so sorting, paging and uniqueness run read-only on existing data` });

  const isoKey = iso?.field.slice(1).replace(/~1/g, '/').replace(/~0/g, '~');
  const lifecycleIso = !!iso && !(x.updatePayload && typeof x.updatePayload === 'object' && isoKey! in (x.updatePayload as object));
  // Without the isolating filter after the update, a list with a required query parameter cannot be read in full.
  const requiredQuery = c.op.params.some((p) => p.in === 'query' && p.required);
  const lifecycle = x.canCreate && x.canUpdate && x.canDelete && Object.keys(c.fields ?? {}).length > 0 && (lifecycleIso || !requiredQuery);
  if (!lifecycle && x.canCreate && x.canUpdate && x.canDelete && requiredQuery && !lifecycleIso) gaps.push({ code: 'CANNOT_ISOLATE_RULE', location: 'lifecycle', reason: `${c.op.key}: the update changes the isolating field and the list needs a required query parameter, so the updated resource cannot be found reliably` });
  else if (!lifecycle) gaps.push({ code: 'UNCONFIRMED_BUSINESS_RULE', location: 'lifecycle', reason: `${c.op.key}: create → list → update → list → delete → list needs a confirmed create, update (with an example payload) and delete, and confirmed field persistence ("fields")` });
  else if (!c.deletedDisappears) gaps.push({ code: 'UNCONFIRMED_BUSINESS_RULE', location: 'lifecycle', reason: `${c.op.key}: that a deleted resource leaves the list is not confirmed ("deletedDisappears"), so the last step is not asserted` });
  return { c, tests, ...(iso ? { iso } : {}), lifecycle, lifecycleIso, gaps, walkSize, pageSize };
}

/** Strategy recorded in coverage for a list operation, with the reasons. */
export function collectionStrategy(plan: CollectionPlan | undefined, why: string[], fixture = false): { strategy: 'create-verify' | 'read-only' | 'fixtures' | 'contract-only'; strategies: string[]; reasons: string[] } {
  const r = base(plan, why);
  if (!fixture) return { ...r, strategies: [r.strategy] };
  const reasons = [...r.reasons, 'approved fixture compared field by field (strategy B)'];
  return r.strategy === 'contract-only' || r.strategy === 'read-only' ? { strategy: 'fixtures', strategies: ['fixtures', ...(r.strategy === 'read-only' ? ['read-only'] : [])], reasons } : { strategy: r.strategy, strategies: [r.strategy, 'fixtures'], reasons };
}

function base(plan: CollectionPlan | undefined, why: string[]): { strategy: 'create-verify' | 'read-only' | 'contract-only'; reasons: string[] } {
  if (!plan) return { strategy: 'contract-only', reasons: why };
  if (plan.tests.some((t) => t.mode === 'controlled')) {
    return { strategy: 'create-verify', reasons: [`controlled dataset${plan.iso ? ` isolated by ${plan.iso.param}` : ''}; ${plan.tests.filter((t) => t.mode === 'read-only').map((t) => `${t.kind} read-only`).join(', ') || 'every check on own data'}`] };
  }
  return { strategy: 'read-only', reasons: ['no confirmed create with cleanup or no isolating filter: properties are checked on existing data, tests without enough data are skipped'] };
}
