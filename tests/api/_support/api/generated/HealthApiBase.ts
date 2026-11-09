// HealthApi requests generated from the spec by api-test-agent 0.1.3.
// Rewritten on every generate: do not edit. Add your own requests to ../HealthApi.ts.
import type { APIResponse } from '@playwright/test';
import { ApiBase, type PathValue, type RequestOptions } from './ApiBase.js';

export class HealthApiBase extends ApiBase {
  /** GET /health · getHealth · Liveness check */
  getHealth(options: RequestOptions = {}): Promise<APIResponse> {
    return this.send('get', `health`, options);
  }
}
