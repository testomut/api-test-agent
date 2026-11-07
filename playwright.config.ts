import { defineConfig } from '@playwright/test';

const baseURL = (process.env.API_BASE_URL ?? 'http://localhost:3100').replace(/\/?$/, '/');

// Credentials only from the environment / CI secrets, never from files in the repo.
const extraHTTPHeaders: Record<string, string> = { accept: 'application/json' };
if (process.env.API_TOKEN) extraHTTPHeaders.authorization = `Bearer ${process.env.API_TOKEN}`;

export default defineConfig({
  testDir: 'tests/generated',
  fullyParallel: true,
  retries: 0, // a flaky generated test is a finding, not something to retry away
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, extraHTTPHeaders },
});
