import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: '*.spec.ts',
  timeout: 600_000,
  reporter: 'list',
  outputDir: '/tmp/tazor-web-test-results',
  use: { baseURL: 'http://localhost:4173', browserName: 'chromium' },
  webServer: { command: 'node scripts/serve.mjs', url: 'http://localhost:4173', reuseExistingServer: false },
});
