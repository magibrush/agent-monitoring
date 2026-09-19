import { test, expect } from "@playwright/test";

test("each bar assigns colors to its own ranked actions", async ({ page }) => {
  const time = Date.now() - 3600000;
  const first = [
    { name: "Bash", count: 80 },
    { name: "Read", count: 20 },
  ];
  const second = [
    { name: "Read", count: 40 },
    { name: "Bash", count: 30 },
    { name: "Rare tool", count: 20 },
    { name: "Rarer tool", count: 10 },
  ];
  const payload = {
    sessions: 1,
    messages: 0,
    questions: 0,
    answers: 0,
    actions: 200,
    series: [first, second].map((tools, i) => ({
      time: time + i * 60000,
      user: 0,
      assistant: 0,
      actions: 100,
      tools,
    })),
    interval_seconds: 60,
    interval_label: "1 minute",
    interval_adjusted: false,
    window_limited: false,
    domain: {
      start: new Date(time).toISOString(),
      end: new Date(time + 120000).toISOString(),
    },
    viewport: {
      start: new Date(time).toISOString(),
      end: new Date(time + 120000).toISOString(),
    },
    tools: first,
  };
  await page.route("**/api/metrics?*", (route) =>
    route.fulfill({ json: payload }),
  );
  await page.goto("/");
  const chart = page.getByTestId("actions-chart");
  await expect(chart.locator(".recharts-bar")).toHaveCount(4);
  const firstRank = chart
    .locator(".recharts-bar")
    .first()
    .locator(".recharts-bar-rectangle");
  await firstRank.nth(0).hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText("Bash");
  await expect(tip).toContainText("80.0%");
  const blue = await tip
    .locator(".chart-color-key")
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await firstRank.nth(1).hover();
  await expect(tip).toContainText("Read");
  await expect(tip).toContainText("Bash");
  await expect(tip).toContainText("Rare tool");
  await expect(tip).toContainText("Rarer tool");
  await expect(tip).not.toContainText("Other actions");
  expect(
    await tip
      .locator(".chart-color-key")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe(blue);
  await firstRank.nth(1).click();
  const detail = page.getByRole("region", { name: "Action breakdown" });
  await expect(detail).toContainText("Read");
  await expect(detail).toContainText("40");
  await expect(detail).toContainText("Rarer tool");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: "../data/qa/per-bar-ranks.png" });
});

test("100 action types have ranked colors, bounded overlay and complete inspection", async ({
  page,
}) => {
  const time = Date.now() - 3600000;
  const tools = Array.from({ length: 100 }, (_, i) => ({
    name: `tool-${i.toString().padStart(2, "0")}`,
    count: i + 1,
  }));
  const payload = {
    sessions: 1,
    messages: 2,
    questions: 1,
    answers: 1,
    actions: 5050,
    series: [0, 1, 2].map((i) => ({
      time: time + i * 60000,
      user: i === 1 ? 1 : 0,
      assistant: i === 1 ? 1 : 0,
      actions: i === 1 ? 5050 : 0,
      tools: i === 1 ? tools : [],
    })),
    interval_seconds: 60,
    interval_label: "1 minute",
    interval_adjusted: false,
    window_limited: false,
    domain: {
      start: new Date(time).toISOString(),
      end: new Date(time + 180000).toISOString(),
    },
    viewport: {
      start: new Date(time).toISOString(),
      end: new Date(time + 180000).toISOString(),
    },
    tools,
  };
  await page.addInitScript(() =>
    localStorage.setItem(
      "relay.chart.tools",
      JSON.stringify(Array.from({ length: 20 }, (_, i) => `old-tool-${i}`)),
    ),
  );
  await page.route("**/api/metrics?*", (route) =>
    route.fulfill({ json: payload }),
  );
  await page.goto("/");
  const chart = page.getByTestId("actions-chart");
  await expect(page.getByLabel("Action colors")).toHaveCount(0);
  await expect(page.getByLabel("Vertical scale")).toHaveValue("linear");
  await expect(chart.locator(".recharts-bar")).toHaveCount(11);
  const colors = await chart
    .locator(".recharts-bar-rectangle path")
    .evaluateAll((nodes) => [
      ...new Set(nodes.map((n) => n.getAttribute("fill"))),
    ]);
  expect(colors).toHaveLength(11);
  for (const bar of await chart.locator(".recharts-bar-rectangle").all()) {
    const box = await bar.boundingBox();
    if (box && box.height > 10) {
      await bar.hover();
      break;
    }
  }
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText("5,050 actions");
  await expect(tip).toContainText("Other actions (90 types)");
  await expect(tip.locator(".tooltip-row")).toHaveCount(11);
  expect(
    await tip.evaluate((el) => el.parentElement === document.body),
  ).toBeTruthy();
  async function checkBounds() {
    const box = (await tip.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  }
  await checkBounds();
  await page.screenshot({ path: "../data/qa/action-tooltip-100.png" });
  await page.mouse.move(0, 0);
  await chart.press("Home"); await chart.press("ArrowRight");
  const breakdown = page.getByRole("region", { name: "Action breakdown" });
  await expect(breakdown.locator(".tooltip-row")).toHaveCount(10);
  await page.getByLabel("Next action types").click();
  await expect(breakdown).toContainText("2 / 10");
  for (let i = 0; i < 8; i++) await page.getByLabel("Next action types").click();
  await expect(breakdown).toContainText("tool-00");
  await page.setViewportSize({ width: 390, height: 600 });
  await chart.scrollIntoViewIfNeeded();
  for (const bar of await chart.locator(".recharts-bar-rectangle").all()) {
    const box = await bar.boundingBox();
    if (box && box.height > 10) {
      await bar.hover();
      break;
    }
  }
  await expect(tip).toBeVisible();
  await checkBounds();
  await expect(tip).not.toContainText("Click bar to inspect");
  await page.screenshot({ path: "../data/qa/action-tooltip-mobile.png" });
});
