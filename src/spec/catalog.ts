import { HTTP_METHODS, type HttpMethod, type Operation, type ParamInfo, type ResponseInfo } from '../types.js';
import { resolvePointer, escapePointer, type OpenApiDoc } from './loader.js';

const deref = (doc: OpenApiDoc, node: any) =>
  node?.$ref ? resolvePointer(doc, node.$ref.slice(1)).node : node;

export function knownValue(param: any, schema: any): unknown {
  if (param?.example !== undefined) return param.example;
  const ex = param?.examples && Object.values(param.examples)[0];
  if (ex && typeof ex === 'object' && 'value' in (ex as any)) return (ex as any).value;
  if (schema?.example !== undefined) return schema.example;
  if (Array.isArray(schema?.examples) && schema.examples.length) return schema.examples[0];
  if (schema?.default !== undefined) return schema.default;
  if (Array.isArray(schema?.enum) && schema.enum.length) return schema.enum[0];
  if (schema?.const !== undefined) return schema.const;
  return undefined;
}

export function buildCatalog(doc: OpenApiDoc): Operation[] {
  const ops: Operation[] = [];
  const globalSecurity: any[] = doc.security ?? [];

  for (const [path, rawItem] of Object.entries<any>(doc.paths ?? {})) {
    const item = deref(doc, rawItem) ?? {};
    const shared: any[] = (item.parameters ?? []).map((p: any) => deref(doc, p));

    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;

      // Operation-level params override path-level ones with the same name+in.
      const own: any[] = (op.parameters ?? []).map((p: any) => deref(doc, p));
      const merged = new Map<string, any>();
      for (const p of [...shared, ...own]) if (p?.name) merged.set(`${p.in}:${p.name}`, p);

      const params: ParamInfo[] = [...merged.values()].map((p) => {
        const schema = deref(doc, p.schema);
        return {
          name: p.name,
          in: p.in,
          required: p.in === 'path' ? true : Boolean(p.required),
          knownValue: knownValue(p, schema),
          schema,
        };
      });

      const body = deref(doc, op.requestBody);
      const responses: ResponseInfo[] = Object.entries<any>(op.responses ?? {}).map(([status, r]) => {
        const resp = deref(doc, r) ?? {};
        const content = resp.content ?? {};
        return {
          status,
          contentTypes: Object.keys(content),
          hasSchema: Object.values<any>(content).some((c) => c?.schema),
        };
      });

      const security: string[][] = (op.security ?? globalSecurity).map((alt: Record<string, unknown>) => Object.keys(alt));

      const issues: string[] = [];
      if (!op.operationId) issues.push('No operationId: generated tests and reports fall back to METHOD path.');
      const success = responses.filter((r) => /^2(\d\d|XX)$/i.test(r.status));
      if (!success.length) issues.push('No 2xx response is documented, so there is no positive contract to check.');
      for (const r of success) {
        if (r.contentTypes.some((c) => c.includes('json')) && !r.hasSchema) {
          issues.push(`Response ${r.status} declares JSON but has no schema: body cannot be validated.`);
        }
      }
      for (const p of params) {
        if (p.required && p.in !== 'header' && p.knownValue === undefined) {
          issues.push(
            `Required ${p.in} parameter "${p.name}" has no example/default/enum: a real value must come from test data or a preceding operation.`,
          );
        }
      }
      if (body?.required && !Object.values<any>(body.content ?? {}).some((c) => c?.schema)) {
        issues.push('Request body is required but has no schema: a valid payload cannot be derived.');
      }

      ops.push({
        key: `${method.toUpperCase()} ${path}`,
        method: method as HttpMethod,
        path,
        operationId: op.operationId,
        summary: op.summary,
        deprecated: Boolean(op.deprecated),
        params,
        hasRequestBody: Boolean(body),
        requestBodyRequired: Boolean(body?.required),
        requestContentTypes: Object.keys(body?.content ?? {}),
        responses,
        security,
        testabilityIssues: issues,
      });
    }
  }
  return ops;
}

/** JSON pointer to an operation inside the document (used for schema $ref lookups). */
export function operationPointer(op: Pick<Operation, 'path' | 'method'>): string {
  return `/paths/${escapePointer(op.path)}/${op.method}`;
}
