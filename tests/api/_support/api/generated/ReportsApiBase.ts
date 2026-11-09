// ReportsApi requests generated from the spec by api-test-agent 0.1.3.
// Rewritten on every generate: do not edit. Add your own requests to ../ReportsApi.ts.
import type { APIResponse } from '@playwright/test';
import { ApiBase, type PathValue, type RequestOptions } from './ApiBase.js';

export class ReportsApiBase extends ApiBase {
  /** GET /reports/{reportId} · getReport · Download a stored report */
  getReport(reportId: PathValue, options: RequestOptions = {}): Promise<APIResponse> {
    return this.send('get', `reports/${this.segment(reportId)}`, options);
  }
}
