import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: '*.spec.ts',
  timeout: 600_000,
  reporter: 'list',
  outputDir: '/tmp/tazor-web-test-results',
  // every spec starts with the ENS directory cached (tests/directory-fixture.ts); the app has no built-in companies
  use: { baseURL: 'http://localhost:4173', browserName: 'chromium', storageState: 'tests/ens-directory.state.json' },
  webServer: { command: 'node scripts/serve.mjs', url: 'http://localhost:4173', reuseExistingServer: false },
});
