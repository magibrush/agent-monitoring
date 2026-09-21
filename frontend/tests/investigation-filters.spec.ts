import { test, expect } from "@playwright/test";
import path from "node:path";
import { mkdir } from "node:fs/promises";

test.beforeEach(async ({ request }) => {
  for (const [name, provider] of [["Filter Desktop", "codex"], ["Filter CLI", "codex_cli"]]) {
    const response = await request.post("/api/connections", { data: { name, provider, path: path.resolve(provider === "codex_cli" ? "../data/e2e-mixed" : "../data/e2e-source") } });
    expect(response.ok()).toBeTruthy();
    const connection = await response.json();
    await request.post(`/api/connections/${connection.id}/sync`);
  }
});

test.afterEach(async ({ request }) => {
  const connections = await (await request.get("/api/connections")).json();
  for (const connection of connections.filter((c: { name: string }) => c.name.startsWith("Filter "))) {
    await request.delete(`/api/connections/${connection.id}`);
  }
});

test("connection scope is shared across views and session type excludes internal reviews", async ({ page }) => {
  const requests: URL[] = [];
  page.on("request", request => { if (request.url().includes("/api/")) requests.push(new URL(request.url())); });
  await page.goto("/");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const [connectionId] = await page.getByLabel("Filter connection", { exact: true }).selectOption({ label: "Filter CLI" });
  await expect(page.getByLabel("Filter provider")).toHaveCount(0);
  await expect(page.getByText("Refine your view", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close filters" })).toHaveCount(0);
  for (const endpoint of ["/api/sessions", "/api/metrics"]) {
    await expect.poll(() => requests.some(url => url.pathname === endpoint && url.searchParams.get("connection") === connectionId)).toBeTruthy();
  }
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  await expect(page.getByLabel("Filter connection", { exact: true })).toHaveValue(connectionId);
  await page.locator(".session-link").first().click();
  await expect.poll(() => requests.some(url => /\/sessions\/.+\/events/.test(url.pathname) && url.searchParams.get("connection") === connectionId)).toBeTruthy();
  await page.getByLabel("Include internal reviews").check();
  await page.getByLabel("Session type", { exact: true }).selectOption("subagent");
  await expect(page.getByLabel("Include internal reviews")).not.toBeChecked();
  await expect(page.getByLabel("Include internal reviews")).toBeDisabled();
  await page.getByRole("button", { name: "Remove Sessions: Subagents", exact: true }).click();
  await expect(page.getByLabel("Include internal reviews")).toBeEnabled();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.getByLabel("Active filters")).toHaveCount(0);
});

test("search scope is visible and clearing committed search restores results", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByLabel("Search scope").selectOption("actions");
  await expect(page.getByLabel("Search conversations", { exact: true })).toHaveAttribute("placeholder", "Search commands, paths, or tool output…");
  await page.getByLabel("Search conversations", { exact: true }).fill("no-such-command-for-filter-test");
  await expect(page.getByText("No matching sessions", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove Search: no-such-command-for-filter-test", exact: true }).click();
  await expect(page.getByLabel("Search conversations", { exact: true })).toHaveValue("");
  await expect(page.locator(".session-link").first()).toBeVisible();
  await expect(page.getByLabel("Search scope")).toHaveValue("actions");
  await page.getByRole("button", { name: "Remove Search in: Tool arguments + output", exact: true }).click();
  await expect(page.getByLabel("Search scope")).toHaveValue("messages");
});

test("base time and chart zoom can be removed independently", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.locator(".range-picker summary").click();
  await page.getByRole("button", { name: "Last 30 days", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Remove Chart zoom:/ })).toBeVisible();
  await page.getByRole("button", { name: /^Remove Chart zoom:/ }).click();
  await expect(page.getByRole("button", { name: /^Remove Chart zoom:/ })).toHaveCount(0);
  await expect(page.locator(".range-picker summary")).toContainText("Last 30 days");
  await page.getByRole("button", { name: "Remove Time: Last 30 days", exact: true }).click();
  await expect(page.locator(".range-picker summary")).toContainText("All time");
  await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toBeDisabled();
});

test("opening a session from Safety clears incompatible investigation filters", async ({ page, request }) => {
  const sessions = await (await request.get("/api/sessions?provider=codex")).json();
  const session = sessions.items[0];
  await page.goto("/");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByLabel("Filter connection", { exact: true }).selectOption({ label: "Filter CLI" });
  await page.getByLabel("Session type", { exact: true }).selectOption("subagent");
  await page.getByLabel("Search scope").selectOption("actions");
  await page.getByRole("button", { name: "Safety", exact: true }).click();
  await page.evaluate(id => { location.hash = `#explorer?session=${encodeURIComponent(id)}&kind=tool_call`; }, session.id);
  await expect(page.locator(".explorer-detail-heading")).toContainText(session.title);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await expect(page.getByLabel("Filter connection", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Session type", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Search scope")).toHaveValue("messages");
});

test("filter layouts remain usable on desktop and mobile", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await expect(page.locator(".session-link").first()).toBeVisible();
  const folder = path.resolve("../data/filter-review");
  await mkdir(folder, { recursive: true });
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  expect((await page.locator(".investigation-filters").boundingBox())!.height).toBeLessThan(75);
  await expect(page.locator(".investigation-context")).toHaveCount(0);
  await page.screenshot({ path: path.join(folder, "desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByLabel("Filter tool name").fill("exec_command");
  await page.getByLabel("Search matching").selectOption("contains");
  await expect(page.getByRole("button", { name: "Remove Tool: exec_command", exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(folder, "desktop-expanded.png"), fullPage: true });
  for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByLabel("Filter tool name")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.screenshot({ path: path.join(folder, `width-${width}.png`), fullPage: true });
  }
  await page.getByLabel("Search matching").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Filters", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Filters", exact: true })).toHaveAccessibleDescription("2 active filters");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Search matching")).toHaveValue("contains");
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(page.locator(".sticky-controls")).toHaveCSS("position", "static");
  await page.locator(".timeline-panel").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(folder, "tablet-scrolled.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".sticky-controls")).toHaveCSS("position", "static");

  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Remove Chart zoom:/ })).toBeVisible();
  await page.screenshot({ path: path.join(folder, "explorer-zoom.png") });
});
