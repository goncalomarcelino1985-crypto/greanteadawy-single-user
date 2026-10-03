// End-to-end tests: a real browser drives the built studio while an MCP client plays "Claude".
// Run with `npm run test:e2e` (builds the client first). Browsers: `npx playwright install chromium`.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 3199);

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
    trace: 'retain-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'node e2e/serve.mjs',
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { E2E_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe'
  }
});
