import { test, expect } from "@playwright/test";

test("connection actions stay available during concurrent syncs", async ({ page }) => {
  const connections = ["first", "second"].map(id => ({
    id, name: `Parallel ${id}`, provider: "codex", path: "C:/synthetic",
    enabled: true, status: "watching", hooks_enabled: false, gate_enabled: false,
    error: null, last_sync: null, session_count: 0,
  }));
  await page.route("**/api/connections", route => route.fulfill({ json: connections }));
  const releases: Array<() => void> = [];
  await page.route("**/api/connections/*/sync", async route => {
    await new Promise<void>(resolve => releases.push(resolve));
    await route.fulfill({ json: connections.find(c => route.request().url().includes(c.id)) });
  });
  await page.route("**/api/connections/check", route => route.fulfill({ json: { matching_sessions: 0, counts: {} } }));
  await page.goto("/");
  await page.getByRole("button", { name: /Connections/ }).click();
  const first = page.locator(".connection-card").filter({ hasText: "Parallel first" });
  const second = page.locator(".connection-card").filter({ hasText: "Parallel second" });
  try {
    await first.getByRole("button", { name: "Sync now" }).click();
    await second.getByRole("button", { name: "Sync now" }).click();
    await expect.poll(() => releases.length).toBe(2);
    await first.getByRole("button", { name: "Check source" }).click();
    await expect(first).toContainText("0 matching sessions");
    for (const card of [first, second]) {
      await expect(card.getByRole("button", { name: "Syncing" })).toBeDisabled();
      await expect(card.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
      await expect(card.getByRole("button", { name: "Set up live hooks" })).toBeEnabled();
      await card.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.getByRole("button", { name: "Delete connection", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    releases[0]();
    await expect(first.getByRole("button", { name: "Sync now" })).toBeEnabled();
    await expect(second.getByRole("button", { name: "Syncing" })).toBeDisabled();
  } finally {
    releases.forEach(release => release());
  }
});
