import { test as base } from '@playwright/test';
import { createItem, deleteItem } from './helpers/items-api';

export const test = base.extend<{ item: { id: string; name: string } }>({
  item: async ({ request }, use) => {
    const item = await createItem(request, { name: 'Fixture item', price: 5 });
    await use(item);
    await deleteItem(request, item.id);
  },
});
