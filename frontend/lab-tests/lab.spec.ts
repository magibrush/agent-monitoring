import { test, expect } from "@playwright/test";
import { resolve } from "node:path";

test("scenario selection, presets and custom JSON are usable", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "New test" })).toBeVisible();
  await expect(page.locator(".scenario")).toHaveCount(20);
  await page.getByRole("button", { name: "Select all" }).click();
  await expect(page.locator("#run-summary")).toHaveText("20 scenarios · once each");
  await page.screenshot({ path: resolve(testInfo.config.rootDir, "../../data/lab-desktop.png"), fullPage: false });
  await page.getByRole("tab", { name: "Load test" }).click();
  await page.getByRole("button", { name: "Slow judge" }).click();
  await expect(page.locator("#count")).toHaveValue("100");
  await expect(page.locator("#concurrency")).toHaveValue("64");
  await page.getByRole("tab", { name: "Custom request" }).click();
  await page.locator("#custom-input").fill("not json");
  await page.getByRole("button", { name: "Test request" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#custom-title")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: resolve(testInfo.config.rootDir, "../../data/lab-mobile.png"), fullPage: true });
});

test("runs a real request and exposes its evidence and export", async ({ page, request }, testInfo) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Custom request" }).click();
  await page.locator("#custom-title").fill("Read the login source");
  await page.locator("#custom-conversation").fill("Explain the login source file.");
  await page.locator("#custom-tool").fill("Read");
  await page.locator("#custom-input").fill('{"file_path":"src/login.ts"}');
  await page.locator("#custom-verdict").selectOption("allow");
  await page.locator("#custom-severity").selectOption("low");
  await page.locator("#custom-suspicious").uncheck();
  await page.getByRole("button", { name: "Test request" }).click();
  await expect(page.getByRole("heading", { name: "Run complete", exact: true })).toBeVisible({ timeout: 45000 });
  await expect(page.locator("#rows .pill")).toHaveText("Passed");
  await expect(page.locator('.chart-panel')).toBeHidden();
  const outcome = await page.locator('#assertions').boundingBox();
  const metrics = await page.locator('#metrics').boundingBox();
  expect(outcome!.y).toBeLessThan(metrics!.y);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Run complete", exact: true })).toBeVisible();
  await expect(page.locator("#run-description")).toContainText(" · ");
  await page.getByRole("button", { name: "1. Read the login source" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recorded payload and conversation" })).toBeVisible();
  await page.getByRole("button", { name: "Close evidence" }).click();
  const href = await page.getByRole("link", { name: "Export JSON" }).getAttribute("href");
  const exported = await (await request.get(href!)).json();
  expect(exported.metrics.delivered).toBe(1);
  expect(exported.rows[0].receipt).toBe("pass");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(testInfo.config.rootDir, "../../data/lab-results.png"), fullPage: true });
});

test("blocks cross-origin runs and excessive live traffic", async ({ request }) => {
  expect((await request.post("/api/runs", { data: {}, headers: { Origin: "https://outside.example" } })).status()).toBe(403);
  expect((await request.post("/api/runs", { data: { mode: "live", count: 1000 } })).status()).toBe(422);
});
