import { test, expect } from "@playwright/test";

test("conversation and safety ranks belong to each bar without global legends", async ({ page, request }) => {
  const base = await (await request.get("/api/metrics")).json();
  const time = Date.now() - 120000;
  const identities = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, title: `Conversation ${i}` }));
  const series = [0, 1].map(i => ({ time: time + i * 60000, sessions: 12, user: 78, assistant: 0, actions: 78, tools: [],
    conversations: identities.map((c, n) => ({ id: c.id, messages: i ? n + 1 : 12 - n, actions: i ? n + 1 : 12 - n })),
    safety: i ? { released: 20, denied: 58 } : { released: 60, denied: 18 },
  }));
  const domain = { start: new Date(time).toISOString(), end: new Date(time + 120000).toISOString() };
  await page.route("**/api/metrics?**", route => route.fulfill({ json: { ...base, sessions: 12, actions: 156, messages: 156, conversation_series: identities, series, domain, viewport: domain, interval_seconds: 60 } }));
  await page.goto("/");
  await expect(page.locator(".chart-mode-note")).toHaveCount(0);
  await page.getByLabel("Color bars by").selectOption("conversation");
  await expect(page.getByLabel("Conversation colors")).toHaveCount(0);
  const bars = page.getByTestId("actions-chart").locator(".recharts-bar").first().locator(".recharts-bar-rectangle");
  await bars.nth(0).hover();
  const tip = page.getByRole("tooltip");
  await expect(tip.locator(".tooltip-row")).toHaveCount(11);
  await expect(tip.locator(".tooltip-row").first()).toContainText("Conversation 0");
  await expect(tip).toContainText("Other conversations");
  await bars.nth(1).hover();
  await expect(tip.locator(".tooltip-row").first()).toContainText("Conversation 11");
  await page.getByLabel("Color bars by").selectOption("safety");
  await expect(page.locator(".safety-chart-summary")).toHaveCount(0);
  await bars.nth(0).hover();
  await expect(tip.locator(".tooltip-row").first()).toContainText("Released");
  await bars.nth(1).hover();
  await expect(tip.locator(".tooltip-row").first()).toContainText("Denied");
  await expect(tip.locator(".tooltip-row")).toHaveCount(2);
  await page.screenshot({ path: "../data/qa/ranked-safety.png" });
});


test("scale stays available after color and interval changes", async ({ page, request }) => {
  const base = await (await request.get("/api/metrics")).json();
  const time = Date.now() - 120000;
  const domain = { start: new Date(time).toISOString(), end: new Date(time + 120000).toISOString() };
  const series = [1, 99].map((n, i) => ({ time: time + i * 60000, sessions: 1, user: n, assistant: 0, actions: n, tools: [{ name: "Read", count: n }], conversations: [{ id: "c1", messages: n, actions: n }], safety: { released: n } }));
  await page.route("**/api/metrics?**", route => route.fulfill({ json: { ...base, sessions: 1, messages: 100, actions: 100, conversation_series: [{ id: "c1", title: "Example" }], series, domain, viewport: domain, interval_seconds: 60 } }));
  await page.goto("/");
  for (const kind of ["Actions", "Messages"]) {
    await page.getByRole("button", { name: `Show ${kind.toLowerCase()} chart` }).click();
    for (const mode of kind === "Actions" ? ["conversation", "safety"] : ["conversation"]) {
      await page.getByLabel("Color bars by").selectOption(mode);
      await page.getByLabel("Bucket size").selectOption("60");
      const scale = page.getByLabel("Vertical scale");
      await expect(scale).toBeEnabled();
      await scale.selectOption("linear");
      const bars = page.getByTestId(`${kind.toLowerCase()}-chart`).locator(".recharts-bar").first().locator(".recharts-bar-rectangle path");
      const linear = await bars.first().getAttribute("height");
      await scale.selectOption("log");
      await expect(scale).toHaveValue("log");
      await expect.poll(async () => Number(await bars.first().getAttribute("height"))).toBeGreaterThan(Number(linear) * 3);
      await page.getByLabel("Bucket size").selectOption("300");
      await expect(scale).toBeEnabled();
      await expect(scale).toHaveValue("log");
    }
  }
});
