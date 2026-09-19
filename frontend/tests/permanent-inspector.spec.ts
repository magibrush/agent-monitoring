import { test, expect } from "@playwright/test";
import path from "node:path";

test("permanent inspector stays put and separates actions, sessions and messages", async ({ page, request }) => {
  const connection = await (await request.post("/api/connections", { data: { name: "Inspector test", provider: "codex", path: path.resolve("../data/e2e-source") } })).json();
  try {
    await request.post(`/api/connections/${connection.id}/sync`);
    await page.goto("/");
    await page.getByLabel("Filter connection").selectOption(connection.id);
    const inspector = page.getByLabel("Bar inspection");
    await expect(inspector).toContainText("Click on a bar to inspect");
    await expect(page.getByRole("button", { name: "Inspect activity" })).toHaveCount(0);
    await expect(page.locator("table input[type=checkbox]")).toHaveCount(0);
    const chart = page.getByTestId("actions-chart");
    await expect(chart).toBeVisible();
    const before = await chart.boundingBox();
    await page.screenshot({ path: "../data/qa/inspector-placeholder.png", fullPage: true });
    const actionMetrics = await (await request.get(`/api/metrics?connection=${connection.id}`)).json();
    await chart.press("Home");
    for (let i = 0; i < actionMetrics.series.findIndex((r: { actions: number }) => r.actions > 0); i++) await chart.press("ArrowRight");
    await expect(inspector.locator("h3")).toHaveText("Actions");
    await expect(inspector.locator(".inspection-session")).toHaveCount(0);
    await expect(chart.locator(".recharts-reference-line line")).toHaveAttribute("stroke-width", "18");
    expect((await chart.boundingBox())!.width).toBe(before!.width);
    await page.screenshot({ path: "../data/qa/inspector-actions.png", fullPage: true });
    await page.getByRole("button", { name: "Show sessions chart" }).click();
    await expect(page.getByTestId("sessions-chart").locator(".recharts-bar-rectangle").first()).toBeVisible();
    const sessionChart = page.getByTestId("sessions-chart");
    await expect(sessionChart.locator(".recharts-bar")).toHaveCount(1);
    const metrics = await (await request.get(`/api/metrics?connection=${connection.id}`)).json();
    const index = metrics.series.findIndex((r: { sessions: number }) => r.sessions > 0);
    await sessionChart.press("Home");
    for (let i = 0; i < index; i++) await sessionChart.press("ArrowRight");
    await expect(inspector.locator("h3")).toHaveText("Sessions");
    await expect(inspector.locator(".inspection-session").first()).toBeVisible();
    await expect(inspector.getByLabel("Action breakdown")).toHaveCount(0);
    await page.screenshot({ path: "../data/qa/inspector-sessions.png", fullPage: true });
    await page.getByRole("button", { name: "Show messages chart" }).click();
    await expect(inspector.locator(".inspection-roles")).toContainText("User");
    await expect(inspector.locator(".inspection-roles")).toContainText("Assistant");
    await page.screenshot({ path: "../data/qa/inspector-messages.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: "../data/qa/inspector-mobile.png", fullPage: true });
  } finally { await request.delete(`/api/connections/${connection.id}`); }
});

test("inspector pagination keeps scroll position while loading and on a short final page", async ({ page, request }) => {
  const base = await (await request.get("/api/metrics")).json();
  const time = Date.now() - 60000;
  const window = { start: new Date(time).toISOString(), end: new Date(time + 60000).toISOString() };
  await page.route("**/api/metrics?**", route => route.fulfill({ json: { ...base, sessions: 6, messages: 6, actions: 0, domain: window, viewport: window, interval_seconds: 60, series: [{ time, user: 6, assistant: 0, actions: 0, sessions: 6, tools: [], safety: {} }] } }));
  await page.route("**/api/sessions?**", async route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("messages_only") !== "true") return route.fulfill({ json: { total: 0, items: [] } });
    const offset = Number(query.get("offset"));
    if (offset) await new Promise(resolve => setTimeout(resolve, 200));
    return route.fulfill({ json: { total: 6, items: Array.from({ length: offset ? 1 : 5 }, (_, i) => ({ id: `${offset + i}`, title: `Conversation ${offset + i}: a longer session title that fills two lines in the inspector`, provider: "codex", messages: 1, actions: 0 })) } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Show messages chart" }).click();
  await page.getByTestId("messages-chart").press("Home");
  await expect(page.locator(".inspection-session")).toHaveCount(5);
  const scroll = page.locator(".inspection-content");
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const before = await scroll.evaluate(el => el.scrollTop);
  expect(before).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Next contributors" }).click();
  await expect(page.locator(".inspection-session")).toHaveCount(1);
  expect(await scroll.evaluate(el => el.scrollTop)).toBe(before);
  await page.getByRole("button", { name: "Previous contributors" }).click();
  await expect(page.locator(".inspection-session")).toHaveCount(5);
  expect(await scroll.evaluate(el => el.scrollTop)).toBe(before);
});
