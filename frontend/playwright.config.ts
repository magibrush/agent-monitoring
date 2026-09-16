import { defineConfig } from "@playwright/test";
const port = Number(process.env.RELAY_E2E_PORT ?? 8000);
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    },
  },
  webServer: {
    command:
      process.platform === "win32"
        ? ".venv\\Scripts\\python.exe -m backend.tests.serve_e2e"
        : ".venv/bin/python -m backend.tests.serve_e2e",
    cwd: "..",
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
