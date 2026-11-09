// ItemsApi requests generated from the spec by api-test-agent 0.1.3.
// Rewritten on every generate: do not edit. Add your own requests to ../ItemsApi.ts.
import type { APIResponse } from '@playwright/test';
import { ApiBase, type PathValue, type RequestOptions } from './ApiBase.js';

export class ItemsApiBase extends ApiBase {
  /** GET /items · listItems · List items */
  listItems(options: RequestOptions = {}): Promise<APIResponse> {
    return this.send('get', `items`, options);
  }

  /** POST /items · createItem · Create an item */
  createItem(options: RequestOptions = {}): Promise<APIResponse> {
    return this.send('post', `items`, options);
  }

  /** GET /items/{itemId} · getItem · Get one item */
  getItem(itemId: PathValue, options: RequestOptions = {}): Promise<APIResponse> {
    return this.send('get', `items/${this.segment(itemId)}`, options);
  }

  /** DELETE /items/{itemId} · deleteItem · Delete an item */
  deleteItem(itemId: PathValue, options: RequestOptions = {}): Promise<APIResponse> {
    return this.send('delete', `items/${this.segment(itemId)}`, options);
  }

  /** PATCH /items/{itemId} · updateItem · Partially update an item */
  updateItem(itemId: PathValue, options: RequestOptions = {}): Promise<APIResponse> {
    return this.send('patch', `items/${this.segment(itemId)}`, options);
  }
}
