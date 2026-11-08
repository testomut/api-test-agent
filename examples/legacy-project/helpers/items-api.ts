import type { APIRequestContext } from '@playwright/test';

export async function createItem(request: APIRequestContext, data: object) {
  const res = await request.post('/items', { data });
  return (await res.json()) as { id: string; name: string };
}

export async function deleteItem(request: APIRequestContext, id: string) {
  await request.delete(`/items/${id}`);
}
