import { expect } from '@playwright/test';
import { test } from '../fixtures';

test('deleted item is gone', async ({ request, item }) => {
  const res = await request.delete(`/items/${item.id}`);
  expect(res.status()).toBe(204);
  const after = await request.get(`/items/${item.id}`);
  expect(after.status()).toBe(404);
});
