// AuthApi requests generated from the spec by api-test-agent 0.1.3.
// Rewritten on every generate: do not edit. Add your own requests to ../AuthApi.ts.
import type { APIResponse } from '@playwright/test';
import { ApiBase, type PathValue, type RequestOptions } from './ApiBase.js';

export class AuthApiBase extends ApiBase {
  /** POST /auth/login · login · Exchange credentials for a short-lived bearer token */
  login(options: RequestOptions = {}): Promise<APIResponse> {
    return this.send('post', `auth/login`, options);
  }
}
