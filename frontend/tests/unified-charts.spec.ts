import { test, expect } from "@playwright/test";
import path from "node:path";

test("right click zooms out in Overview and Safety without inspecting a bar", async ({ page, request }) => {
  const connection = await (await request.post("/api/connections", { data: { name: "Right click zoom", provider: "codex", path: path.resolve("../data/e2e-source") } })).json();
  try {
    await request.post(`/api/connections/${connection.id}/sync`);
    await page.goto("/");
    for (const view of ["Overview", "Safety"]) {
      await page.getByRole("button", { name: view, exact: true }).click();
      await page.getByLabel("Filter connection").selectOption(connection.id);
      const chart = page.getByTestId(view === "Overview" ? "actions-chart" : "safety-chart");
      await expect(chart).toBeVisible();
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await expect(page.getByRole("button", { name: "Zoom out", exact: true })).toBeEnabled();
      await chart.evaluate(el => el.addEventListener("contextmenu", event => {
        setTimeout(() => el.setAttribute("data-menu-prevented", String(event.defaultPrevented)), 0);
      }, { once: true }));
      await chart.click({ button: "right", position: { x: 150, y: 70 } });
      await expect(chart).toHaveAttribute("data-menu-prevented", "true");
      await expect(page.getByRole("button", { name: "Zoom out", exact: true })).toBeDisabled();
      if (view === "Overview") await expect(page.getByLabel("Bar inspection")).toContainText("Click on a bar to inspect");
      else await expect(page.locator(".history-scope")).toHaveCount(0);
    }
  } finally { await request.delete(`/api/connections/${connection.id}`); }
});

test("one Overview chart, shared Safety zoom controls and neutral tooltips", async ({ page, request }) => {
  const response = await request.post("/api/connections", { data: { name: "Unified charts", provider: "codex", path: path.resolve("../data/e2e-source") } });
  const connection = await response.json();
  try {
    await request.post(`/api/connections/${connection.id}/sync`);
    await page.goto("/");
    await page.getByLabel("Filter connection").selectOption(connection.id);
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pan earlier", exact: true })).toBeEnabled();
    await expect(page.locator(".range-picker summary")).not.toContainText("All time");
    await page.locator(".range-picker summary").click();
    await expect(page.getByLabel("Range start", { exact: true })).not.toHaveValue("");
    await expect(page.locator(".range-popover")).not.toContainText("end exclusive");
    await page.locator(".advanced-filters summary").click();
    await expect(page.locator(".range-picker")).not.toHaveAttribute("open", "");
    await page.getByLabel("Filter connection").focus();
    await expect(page.locator(".advanced-filters")).not.toHaveAttribute("open", "");
    await expect(page.locator(".selection-summary")).toHaveCount(0);
    const end = await page.getByRole("slider", { name: "Range end handle" }).getAttribute("aria-valuenow");
    for (const kind of ["sessions", "messages", "actions"]) {
      await page.getByRole("button", { name: `Show ${kind} chart` }).click();
      await expect(page.getByRole("button", { name: `Show ${kind} chart` })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".signal-plot")).toHaveCount(1);
      await expect(page.getByTestId(`${kind}-chart`)).toBeVisible();
      await expect(page.getByRole("slider", { name: "Range end handle" })).toHaveAttribute("aria-valuenow", end!);
    }
    await page.getByRole("button", { name: "Reset zoom" }).click();
    await expect(page.locator(".range-picker summary")).toContainText("All time");
    await page.getByRole("button", { name: "Show sessions chart" }).click();
    await expect(page.getByTestId("sessions-chart").locator(".recharts-bar-rectangle").first()).toBeVisible();
    await page.screenshot({ path: "../data/qa/unified-overview.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: "../data/qa/unified-overview-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Safety", exact: true }).click();
    await page.getByLabel("Filter connection").selectOption(connection.id);
    await expect(page.getByTestId("safety-chart")).toBeVisible();
    await page.getByLabel("Bucket size").selectOption("300");
    await expect(page.getByLabel("Bucket size")).toHaveValue("300");
    await expect(page.locator(".time-chart-caption")).toContainText("600-bucket window");
    const plot = page.getByTestId("safety-chart"), box = (await plot.boundingBox())!;
    await page.mouse.move(box.x + box.width * .3, box.y + 60); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .65, box.y + 60, { steps: 8 }); const dragged = page.waitForResponse(r => r.url().includes("/api/metrics?") && r.url().includes("view_start"));
    await page.mouse.up(); await dragged;
    await expect(page.getByRole("button", { name: "Reset zoom" })).toBeEnabled();
    await expect(page.getByLabel("Bucket size")).toHaveValue("300");
    const handle = page.getByRole("slider", { name: "Range end handle" });
    const before = await handle.getAttribute("aria-valuenow");
    await handle.focus(); await page.keyboard.press("ArrowLeft");
    await expect(handle).not.toHaveAttribute("aria-valuenow", before!);
    await page.getByRole("button", { name: "Reset zoom" }).click();
    for (const bar of await plot.locator(".recharts-bar-rectangle").all()) {
      const area = await bar.boundingBox(); if (area && area.height > 1) { await bar.hover(); break; }
    }
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator(".chart-color-key").first()).toBeVisible();
    const colors = await tooltip.locator(".tooltip-row").evaluateAll(rows => rows.map(row => getComputedStyle(row).color));
    expect(new Set(colors).size).toBe(1);
    await page.screenshot({ path: "../data/qa/unified-safety-tooltip.png" });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: "../data/qa/unified-safety.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: "../data/qa/unified-safety-mobile.png", fullPage: true });
  } finally { await request.delete(`/api/connections/${connection.id}`); }
});

test("Safety zoom returns paginated history to its first page", async ({ page, request }) => {
  const base = await (await request.get("/api/metrics")).json();
  const end = Date.now(), start = end - 86400000 * 7;
  const safety = { released: 1, denied: 1, error: 1, shadow: 1, unassessed: 1, pending: 1, awaiting_review: 1 };
  await page.route("**/api/metrics?**", route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { ...base, actions: 7, safety, interval_seconds: 86400 * 7,
      domain: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      viewport: { start: params.get("view_start") || new Date(start).toISOString(), end: params.get("view_end") || new Date(end).toISOString() },
      series: [{ time: start, actions: 7, user: 0, assistant: 0, sessions: 1, tools: [], safety }] } });
  });
  await page.route("**/api/safety/actions?**", route => {
    const params = new URL(route.request().url()).searchParams;
    const narrowed = params.get("start") && Date.parse(params.get("start")!) > start;
    const total = params.get("safety_state") === "awaiting_review" ? 0 : narrowed ? 3 : 41;
    const offset = Number(params.get("offset") || 0);
    return route.fulfill({ json: { total, items: Array.from({ length: Math.max(0, Math.min(20, total - offset)) }, (_, i) => ({ event_id: offset + i, tool_name: "Read", title: "Synthetic action", occurred_at: new Date(start).toISOString(), safety_state: "unassessed", evaluation: null })) } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Safety", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator(".safety-pager")).toContainText("21–40 of 41");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.locator(".safety-pager")).toContainText("1–3 of 3");
  await expect(page.getByLabel("Safety actions").getByRole("button")).toHaveCount(3);
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await page.setViewportSize({ width: 1440, height: 580 });
  await page.getByTestId("safety-chart").locator(".recharts-bar-rectangle").first().hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  for (const row of await tooltip.locator(".tooltip-row").all()) await expect(row).toBeVisible();
  await expect(tooltip.locator(".tooltip-row")).toHaveCount(7);
  const endDate = await page.evaluate(value => new Date(value).toLocaleString(), end);
  await expect(tooltip.locator("strong").first()).toContainText(endDate);
  await page.screenshot({ path: "../data/qa/unified-safety-daily-tooltip.png" });
});
