import { test, expect } from "@playwright/test";
import path from "node:path";

test("filters and chart window survive navigation; Overview sessions open Explorer", async ({ page, request }) => {
  const connection = await (await request.post("/api/connections", { data: { name: "Navigation test", provider: "codex", path: path.resolve("../data/e2e-source") } })).json();
  try {
    await request.post(`/api/connections/${connection.id}/sync`);
    await page.goto("/");
    await page.getByLabel("Filter connection").selectOption(connection.id);
    await page.getByLabel("Search conversations", { exact: true }).fill("Investigate ingestion delays");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await page.getByLabel("Bucket size").selectOption("60");
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect(page.locator(".range-picker summary")).not.toContainText("All time");
    const date = await page.locator(".range-picker summary").innerText();
    const window = await page.locator(".time-chart-caption").innerText();
    await page.getByRole("button", { name: "Explorer", exact: true }).click();
    await expect(page.getByLabel("Search conversations", { exact: true })).toHaveValue("Investigate ingestion delays");
    await expect(page.locator(".range-picker summary")).toHaveText(date);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await expect(page.locator(".range-picker summary")).toHaveText(date);
    await expect(page.locator(".time-chart-caption")).toHaveText(window, { useInnerText: true });
    await expect(page.getByLabel("Bucket size")).toHaveValue("60");
    await page.locator(".session-link").first().click();
    await expect(page.getByRole("heading", { name: "Explorer", exact: true })).toBeVisible();
    await expect(page.locator(".explorer-detail-heading")).toContainText("Investigate ingestion delays");
    await expect(page.locator("tbody tr.selected")).toHaveCount(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel("Show setup context")).toHaveCount(0);
    await expect(page.getByLabel("Full session time range")).toHaveCount(0);
    await expect(page.locator(".detail-note")).toHaveCount(0);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Clear all", exact: true }).click();
    await expect(page.locator(".range-picker summary")).toContainText("All time");
    await page.getByRole("button", { name: "Show sessions chart" }).click();
    const chart = page.getByTestId("sessions-chart");
    const metrics = await (await request.get("/api/metrics")).json();
    await chart.press("Home");
    for (let i = 0; i < metrics.series.findIndex((r: { sessions: number }) => r.sessions > 0); i++) await chart.press("ArrowRight");
    await page.locator(".inspection-session").first().click();
    await expect(page.locator(".explorer-detail-heading")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally { await request.delete(`/api/connections/${connection.id}`); }
});

test("Explorer routes restore sessions, action views, and browser history", async ({ page, request }) => {
  const connection = await (await request.post("/api/connections", { data: { name: "Explorer routes", provider: "codex", path: path.resolve("../data/e2e-source") } })).json();
  try {
    await request.post(`/api/connections/${connection.id}/sync`);
    await page.goto("/#explorer");
    await expect(page.getByRole("heading", { name: "Explorer", exact: true })).toBeVisible();
    await expect(page.locator(".explorer-detail-heading")).toHaveCount(0);
    const rows = page.locator(".session-link");
    await rows.nth(0).click();
    await expect(page).toHaveURL(/#explorer\?session=/);
    const firstUrl = page.url();
    const firstTitle = await page.locator(".explorer-detail-heading h2").innerText();
    await rows.nth(1).click();
    const secondTitle = await page.locator(".explorer-detail-heading h2").innerText();
    expect(secondTitle).not.toBe(firstTitle);
    await page.goBack();
    await expect(page).toHaveURL(firstUrl);
    await expect(page.locator(".explorer-detail-heading h2")).toHaveText(firstTitle);
    await page.goForward();
    await expect(page.locator(".explorer-detail-heading h2")).toHaveText(secondTitle);
    await page.reload();
    await expect(page.locator(".explorer-detail-heading h2")).toHaveText(secondTitle);
    await page.getByRole("button", { name: "Explorer", exact: true }).click();
    await expect(page).toHaveURL(/#explorer$/);
    await expect(page.locator(".explorer-detail-heading")).toHaveCount(0);
    await page.getByRole("button", { name: /^Inspect actions in/ }).first().click();
    await expect(page).toHaveURL(/kind=tool_call/);
    await page.reload();
    await expect(page.getByLabel("Filter event type")).toHaveValue("tool_call");
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.goBack();
    await expect(page.getByLabel("Filter event type")).toHaveValue("tool_call");
  } finally { await request.delete(`/api/connections/${connection.id}`); }
});
