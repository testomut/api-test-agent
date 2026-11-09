// StatsApi requests generated from the spec by api-test-agent 0.1.3.
// Rewritten on every generate: do not edit. Add your own requests to ../StatsApi.ts.
import type { APIResponse } from '@playwright/test';
import { ApiBase, type PathValue, type RequestOptions } from './ApiBase.js';

export class StatsApiBase extends ApiBase {
  /** GET /stats · getStats · Inventory statistics */
  getStats(options: RequestOptions = {}): Promise<APIResponse> {
    return this.send('get', `stats`, options);
  }
}
