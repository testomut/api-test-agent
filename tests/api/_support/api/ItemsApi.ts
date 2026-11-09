// Your ItemsApi: reusable requests and flows built on the generated ones.
// Created once by api-test-agent and never overwritten: edit freely.
// The generated requests (one per operation) are in ./generated/ItemsApiBase.ts.
import { ItemsApiBase } from './generated/ItemsApiBase.js';

export class ItemsApi extends ItemsApiBase {
  // Example: a flow other tests reuse. Another API object: new OtherApi(this.request).
  //
  // async createOne(data = { name: 'qa' }) {
  //   const res = await this.someCreateOperation({ data });
  //   if (!res.ok()) throw new Error(`create failed: ${res.status()}`);
  //   return res.json();
  // }
}
