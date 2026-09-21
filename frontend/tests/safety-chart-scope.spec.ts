import { test, expect } from "@playwright/test";

test("Safety bars and inspection share outcome and tool scope without a clear-click strip", async ({ page, request }) => {
  const base = await (await request.get("/api/metrics")).json();
  const start = Date.parse("2026-09-17T00:00:00Z"), end = start + 7200000;
  await page.route("**/api/metrics?**", route => {
    const filtered = new URL(route.request().url()).searchParams.get("tool") === "Read";
    const safety = { denied: filtered ? 1 : 2, shadow: 3 };
    return route.fulfill({ json: { ...base, actions: 5, safety, interval_seconds: 3600,
      domain: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      viewport: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      series: [{ time: start, actions: 3, safety: { shadow: 3 }, tools: [] }, { time: start + 3600000, actions: safety.denied, safety: { denied: safety.denied }, tools: [] }] } });
  });
  await page.route("**/api/safety/actions?**", route => {
    const params = new URL(route.request().url()).searchParams;
    const total = params.get("safety_state") === "awaiting_review" ? 0 : params.get("safety_state") === "denied" ? (params.get("tool") === "Read" ? 1 : 2) : 5;
    return route.fulfill({ json: { total, items: Array.from({ length: total }, (_, i) => ({ event_id: i, tool_name: "Read", title: "Scoped action", occurred_at: new Date(start + 3600000).toISOString(), safety_state: "denied", evaluation: null })) } });
  });
  await page.goto("/#safety?view=history");
  await page.getByRole("button", { name: "Denied 2", exact: true }).click();
  const bars = page.getByTestId("safety-chart").locator(".recharts-bar-rectangle path");
  await expect(bars).toHaveCount(1);
  await bars.first().hover();
  await expect(page.getByRole("tooltip")).toContainText("Denied");
  await expect(page.getByRole("tooltip")).not.toContainText("Shadow");
  const scoped = page.waitForRequest(r => r.url().includes("/api/safety/actions?") && new URL(r.url()).searchParams.get("start") === new Date(start + 3600000).toISOString());
  await bars.first().click(); await scoped;
  await expect(page.getByLabel("Safety actions").getByRole("button")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Clear interval/ })).toHaveCount(0);
  await expect(page.locator(".history-scope")).toHaveCount(0);
  const metrics = page.waitForRequest(r => r.url().includes("/api/metrics?") && new URL(r.url()).searchParams.get("tool") === "Read");
  await page.getByRole("textbox", { name: "Find a tool" }).fill("Read"); await metrics;
  await expect(page.getByRole("button", { name: "Denied 1", exact: true })).toBeVisible();
  await expect(page.getByLabel("Safety actions").getByRole("button")).toHaveCount(1);
});

test("live history refresh retains rows and the selected action", async ({ page, request }) => {
  const base = await (await request.get("/api/metrics")).json();
  const start = Date.now() - 3600000;
  const end = start + 3600000;
  let advance = false;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  await page.route("**/api/metrics?**", route => {
    const window = { start: new Date(start).toISOString(), end: new Date(end + (advance ? 1000 : 0)).toISOString() };
    return route.fulfill({ json: { ...base, actions: 2, safety: { unassessed: 2 }, domain: window, viewport: window, interval_seconds: 60, series: [] } });
  });
  await page.route("**/api/safety/actions?**", async route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("safety_state") === "awaiting_review") return route.fulfill({ json: { total: 0, items: [] } });
    if (params.get("end") === new Date(end + 1000).toISOString()) await refreshGate;
    return route.fulfill({ json: { total: 2, items: [1, 2].map(id => ({ event_id: id, tool_name: id === 1 ? "Bash" : "Read", title: "Live history session", occurred_at: new Date(start).toISOString(), safety_state: "unassessed", evaluation: null })) } });
  });
  try {
    await page.goto("/#safety?view=history");
    const rows = page.getByLabel("Safety actions").getByRole("button");
    await expect(rows).toHaveCount(2);
    await rows.first().click();
    await expect(page.getByLabel("Action details", { exact: true })).toContainText("Bash request");
    await expect(page.locator(".action-session-label")).toHaveCount(0);
    const refreshing = page.waitForRequest(r => r.url().includes("/api/safety/actions?") && new URL(r.url()).searchParams.get("end") === new Date(end + 1000).toISOString());
    advance = true;
    await refreshing;
    // The next live window is deliberately held pending.
    await expect(rows).toHaveCount(2);
    await expect(page.getByLabel("History results")).not.toContainText("Loading actions");
    await rows.nth(1).click();
    await expect(page.getByLabel("Action details", { exact: true })).toContainText("Read request");
    releaseRefresh();
    await expect(rows.nth(1)).toHaveAttribute("aria-pressed", "true");
  } finally { releaseRefresh(); }
});
