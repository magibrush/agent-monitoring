import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./lab-tests",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:8018",
    viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
  },
  webServer: {
    command: process.platform === "win32" ? ".venv\\Scripts\\python.exe -m lab.server --port 8018" : ".venv/bin/python -m lab.server --port 8018",
    cwd: "..",
    url: "http://127.0.0.1:8018/api/catalog",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
