import { defineConfig } from "@playwright/test";

const port = Number(process.env.RELAY_DEMO_TEST_PORT ?? 18001);
export default defineConfig({
  testDir: "./demo-tests",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1100 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
  },
  webServer: {
    command: `${process.platform === "win32" ? ".venv\\Scripts\\python.exe" : ".venv/bin/python"} -m backend.demo --no-browser --port ${port}`,
    cwd: "..",
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
