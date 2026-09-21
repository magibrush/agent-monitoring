import { test, expect } from "@playwright/test";

test("Debug defaults off, reveals one result control, and persists", async ({ page, request }) => {
  await request.put("/api/safety/debug", { data: { enabled: false, result: "review" } });
  try {
    await page.goto("/#safety");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "Debug mode" });
    await expect(toggle).not.toBeChecked();
    await expect(page.getByLabel("Debug settings")).toContainText("Overrides custom policies and the judge");
    await expect(page.getByLabel("Forced judge result")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(page.getByLabel("Forced judge result")).toHaveValue("review");
    await expect(page.getByLabel("Forced judge result")).toBeEnabled();
    await page.getByLabel("Debug settings").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "../data/qa/safety-settings-debug-active.png", fullPage: true });
    await page.getByLabel("Forced judge result").selectOption("deny");
    await expect(page.getByLabel("Forced judge result")).toBeEnabled();
    await page.reload();
    await expect(page.getByLabel("Safety evaluation status")).toContainText("Forced deny");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(toggle).toBeChecked();
    await expect(page.getByLabel("Forced judge result")).toHaveValue("deny");
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByLabel("Forced judge result")).toHaveCount(0);
  } finally {
    await request.put("/api/safety/debug", { data: { enabled: false, result: "review" } });
  }
});


test("Safety settings groups controls and keeps debug last on desktop and mobile", async ({ page }) => {
  await page.route("**/api/connections", route => route.fulfill({ json: [
    { id: "settings-demo", name: "Codex · Local workspace", provider: "codex", hooks_enabled: true, gate_enabled: true },
    { id: "settings-other", name: "Claude · Research workspace", provider: "claude", hooks_enabled: true, gate_enabled: false },
  ] }));
  await page.route("**/api/safety", route => route.fulfill({ json: {
    model: "claude-haiku-4-5", key_configured: true, key_file: "C:/Users/example/.relay/anthropic.key", workers: [{}], counts: {},
    debug: { enabled: false, result: "review" },
    performance: { requests: 218, automatic_pause: { p95_ms: 1240, samples: 210 }, failed: 1, expired: 2, missing_receipts: 5, truncated: false },
  } }));
  await page.goto("/#safety");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Safety settings" });
  await expect(dialog.getByLabel("Debug settings")).toContainText("When enabled: Review");
  await expect(dialog.locator(".safety-settings-body > :last-child")).toHaveAttribute("aria-label", "Debug settings");
  await expect(dialog.getByRole("button", { name: "Configure protection for Codex · Local workspace" })).toBeVisible();
  await expect(dialog.getByText("Connected", { exact: true })).toBeVisible();
  await page.screenshot({ path: "../data/qa/safety-settings-desktop.png", fullPage: true });
  await dialog.getByLabel("Debug settings").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "../data/qa/safety-settings-danger-zone.png", fullPage: true });
  await dialog.locator("summary").filter({ hasText: "Performance" }).click();
  await expect(dialog).toContainText("1.24 s");
  await dialog.getByText("Judge setup", { exact: true }).click();
  await expect(dialog.locator(".safety-path")).toContainText("anthropic.key");
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByLabel("Debug settings").scrollIntoViewIfNeeded();
  await expect(dialog.getByRole("switch", { name: "Debug mode" })).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
  await page.screenshot({ path: "../data/qa/safety-settings-mobile.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
});
