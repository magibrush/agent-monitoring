import { test, expect } from "@playwright/test";

test("token columns and Sessions token chart show reported usage", async ({ page, request }) => {
  const base = await (await request.get("/api/metrics")).json();
  const time = Date.now() - 60000, window = { start: new Date(time).toISOString(), end: new Date(time + 60000).toISOString() };
  const session = { id: "token-session", title: "Token session", provider: "codex", connection_name: "Synthetic", messages: 1, actions: 0, input_tokens: 12345, output_tokens: 678, tokens_partial: false, updated_at: window.end, external_id: "tokens", session_type: "conversation" };
  await page.route("**/api/sessions?**", route => route.fulfill({ json: { total: 1, items: [session] } }));
  await page.route("**/api/metrics?**", route => route.fulfill({ json: { ...base, sessions: 1, messages: 1, actions: 0, domain: window, viewport: window, interval_seconds: 60, series: [{ time, sessions: 1, user: 1, assistant: 0, actions: 0, input_tokens: 12345, output_tokens: 678, tools: [], safety: {} }] } }));
  await page.goto("/");
  await expect(page.getByRole("columnheader", { name: "INPUT TOKENS" })).toBeVisible();
  await expect(page.locator("tbody tr")).toContainText("12,345");
  await expect(page.locator("tbody tr")).toContainText("678");
  await page.getByRole("button", { name: "Show sessions chart" }).click();
  await page.getByLabel("Color bars by").selectOption("tokens");
  await expect(page.locator(".unified-chart-heading")).toHaveText("Tokens");
  const chart = page.getByTestId("sessions-chart");
  await expect(chart.locator(".recharts-bar")).toHaveCount(2);
  await chart.locator(".recharts-bar-rectangle").first().hover();
  await expect(page.getByRole("tooltip")).toContainText("Input tokens");
  await expect(page.getByRole("tooltip")).toContainText("12,345");
  await expect(page.getByRole("tooltip")).toContainText("Output tokens");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: "../data/qa/token-chart.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: "../data/qa/token-chart-mobile.png", fullPage: true });
});

test("Explorer shows token usage in the inspector instead of table columns", async ({ page }) => {
  const session = { id: "token-session", title: "Token session", provider: "codex", connection_name: "Synthetic", messages: 1, actions: 0, input_tokens: 12345, output_tokens: 678, tokens_partial: true, updated_at: new Date().toISOString(), external_id: "tokens", session_type: "conversation" };
  await page.route("**/api/sessions?**", route => route.fulfill({ json: { total: 1, items: [session] } }));
  await page.route("**/api/sessions/token-session/events?**", route => route.fulfill({ json: { total: 0, offset: 0, items: [] } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "INPUT TOKENS" })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "OUTPUT TOKENS" })).toHaveCount(0);
  await page.getByRole("button", { name: /Token session/ }).first().click();
  const usage = page.getByLabel("Session token usage");
  await expect(usage).toContainText("12,345");
  await expect(usage).toContainText("678");
  await expect(usage).toContainText("Partial usage");
  await page.screenshot({ path: "../data/qa/explorer-token-inspector.png", fullPage: true });
});
