import { test, expect } from '@playwright/test';

test('home page shows the catalogue', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(2000);
  await expect(page.getByRole('heading', { name: 'Catalogue' })).toBeVisible();
});
