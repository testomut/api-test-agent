import { test, expect } from '@playwright/test';

const TOKEN = 'Bearer d3f4ult-adm1n-t0ken-123456';

test.describe('Items', () => {
  let itemId: string;
  let secondId: string;

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/items', { data: { name: 'Legacy item', price: 10 } });
    const body = await res.json();
    itemId = body.id;
  });

  test('get item', async ({ request }) => {
    const res = await request.get(`/items/${itemId}`);
    expect(res.status()).toBe(200);
  });

  test('update item price', async ({ request }) => {
    const res = await request.patch(`/items/${itemId}`, { data: { price: 12 }, headers: { authorization: TOKEN } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.price).toBe(12);
  });

  test('item without name is rejected', async ({ request }) => {
    const res = await request.post('/items', { data: { price: 1 } });
    expect(res.status()).toBe(400);
  });

  test('create second item', async ({ request }) => {
    const res = await request.post('/items', { data: { name: 'Second', price: 3 } });
    expect(res.status()).toBe(201);
    secondId = (await res.json()).id;
  });

  test('read second item', async ({ request }) => {
    const res = await request.get(`/items/${secondId}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).name).toBe('Second');
  });

  test('list items', async ({ request }) => {
    const res = await request.get('https://shop-api.example.com/items?limit=5');
    expect(res.ok()).toBeTruthy();
  });
});
