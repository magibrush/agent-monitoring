import { test, expect } from "@playwright/test";

test("Debug defaults off, reveals one result control, and persists", async ({ page, request }) => {
  await request.put("/api/safety/debug", { data: { enabled: false, result: "review" } });
  try {
    await page.goto("/#safety");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "Debug mode" });
    await expect(toggle).not.toBeChecked();
    await expect(page.getByLabel("Forced judge result")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(page.getByLabel("Forced judge result")).toHaveValue("review");
    await expect(page.getByLabel("Forced judge result")).toBeEnabled();
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
