import { test, expect } from "@playwright/test";

test("Safety chart and actions refresh without a reload", async ({ page, request }) => {
  const base = await (await request.get("/api/metrics")).json();
  const start = Date.now() - 3600000, end = Date.now();
  let count = 1;
  await page.route("**/api/metrics?**", route => route.fulfill({ json: { ...base, actions: count,
    safety: { released: count }, interval_seconds: 3600,
    domain: { start: new Date(start).toISOString(), end: new Date(end + (count - 1) * 1000).toISOString() },
    viewport: { start: new Date(start).toISOString(), end: new Date(end + (count - 1) * 1000).toISOString() },
    series: [{ time: start, actions: count, safety: { released: count }, tools: [] }] } }));
  await page.route("**/api/safety/actions?**", route => {
    const waiting = new URL(route.request().url()).searchParams.get("safety_state") === "awaiting_review";
    return route.fulfill({ json: { total: waiting ? 0 : count, items: waiting ? [] : Array.from({ length: count }, (_, i) => ({ event_id: i, tool_name: "Read", title: `Live action ${i}`, occurred_at: new Date(start).toISOString(), safety_state: "released", evaluation: null })) } });
  });
  await page.goto("/#safety?view=history");
  await expect(page.getByRole("button", { name: "Released 1", exact: true })).toBeVisible();
  await expect(page.getByLabel("Safety actions").getByRole("button")).toHaveCount(1);
  await page.getByLabel("Safety actions").getByRole("button").first().click();
  await expect(page.getByLabel("Action details", { exact: true })).toBeVisible();
  count = 2;
  await expect(page.getByRole("button", { name: "Released 2", exact: true })).toBeVisible({ timeout: 7000 });
  await expect(page.getByLabel("Safety actions").getByRole("button")).toHaveCount(2);
  await expect(page.getByLabel("Action details", { exact: true })).toBeVisible();
  await page.getByTestId("safety-chart").locator(".recharts-bar-rectangle path").first().hover();
  await expect(page.getByRole("tooltip")).toContainText("2");
  await expect(page).toHaveURL(/#safety\?view=history$/);
});

test("Last hour keeps a relative query across polling and Overview navigation", async ({ page }) => {
  const recentRequests: URL[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/metrics" && url.searchParams.get("last_seconds") === "3600") recentRequests.push(url);
  });
  await page.goto("/#safety?view=history");
  await page.locator(".safety-history .range-picker summary").click();
  await page.getByRole("button", { name: "Last hour", exact: true }).click();
  await expect.poll(() => recentRequests.length, { timeout: 7000 }).toBeGreaterThanOrEqual(4);
  expect(recentRequests.every(url => !url.searchParams.get("start") && !url.searchParams.get("end"))).toBeTruthy();
  await expect(page.locator(".safety-history .range-picker summary")).toContainText("Last hour");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.locator(".sticky-controls .range-picker summary").click();
  await page.getByRole("button", { name: "Last hour", exact: true }).click();
  await expect.poll(() => recentRequests.length).toBeGreaterThanOrEqual(6);
  await expect(page.locator(".sticky-controls .range-picker summary")).toContainText("Last hour");
});
