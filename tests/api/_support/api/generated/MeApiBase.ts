// MeApi requests generated from the spec by api-test-agent 0.1.3.
// Rewritten on every generate: do not edit. Add your own requests to ../MeApi.ts.
import type { APIResponse } from '@playwright/test';
import { ApiBase, type PathValue, type RequestOptions } from './ApiBase.js';

export class MeApiBase extends ApiBase {
  /** GET /me · getMe · The user the token belongs to */
  getMe(options: RequestOptions = {}): Promise<APIResponse> {
    return this.send('get', `me`, options);
  }
}
