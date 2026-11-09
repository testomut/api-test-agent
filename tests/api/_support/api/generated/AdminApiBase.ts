// AdminApi requests generated from the spec by api-test-agent 0.1.3.
// Rewritten on every generate: do not edit. Add your own requests to ../AdminApi.ts.
import type { APIResponse } from '@playwright/test';
import { ApiBase, type PathValue, type RequestOptions } from './ApiBase.js';

export class AdminApiBase extends ApiBase {
  /** POST /admin/reset · resetInventory · Delete all items */
  resetInventory(options: RequestOptions = {}): Promise<APIResponse> {
    return this.send('post', `admin/reset`, options);
  }
}
