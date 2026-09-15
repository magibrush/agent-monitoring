import { test, expect } from "@playwright/test";
import path from "node:path";
import { appendFile } from "node:fs/promises";

test("connect multiple desktops, sync, aggregate, search, inspect, and pause", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByText("Start with a connection", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await page.getByLabel("Connection name").fill("Development workspace");
  await page
    .getByLabel("Sessions directory")
    .fill(path.resolve("../data/e2e-source"));
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Development workspace" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("Codex sync completed.")).toBeVisible();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Investigate ingestion delays/ }).first(),
  ).toBeVisible();
  await expect
    .poll(
      async () => (await (await request.get("/api/metrics")).json()).messages,
    )
    .toBe(70);
  await appendFile(
    path.resolve("../data/e2e-source/rollout-6.jsonl"),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Live follow-up from the transcript watcher.",
          },
        ],
      },
    }) + "\n",
  );
  await expect
    .poll(
      async () => (await (await request.get("/api/metrics")).json()).messages,
      { timeout: 15000 },
    )
    .toBe(71);
  await page
    .getByLabel("Select Investigate ingestion delays", { exact: true })
    .check();
  await expect(
    page.locator(".selection-label").filter({ hasText: "1 session selected" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".stat")
      .filter({ hasText: "User + assistant messages" })
      .locator(".stat-value"),
  ).toHaveText("11");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByLabel("Sort sessions").selectOption("title");
  await expect(page.locator("tbody tr").first()).toContainText(
    "Add connection health checks",
  );
  await page
    .getByLabel("Search conversations", { exact: true })
    .fill("migration");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page
    .getByRole("button", { name: /Database migration planning/ })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByText("Please explain step 1.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Filter event type").selectOption("tool_call");
  await expect(page.locator(".message")).toHaveCount(2);
  await page.locator("summary").first().click();
  await expect(page.locator("pre").first()).toContainText("README.md");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("Clear search", { exact: true }).click();
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText("Claude Desktop"),
  ).toHaveCount(0);
  await page.getByLabel("Connection name").fill("Research workspace");
  await page
    .getByLabel("Sessions directory")
    .fill(path.resolve("../data/e2e-secondary"));
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  const second = page
    .locator(".connection-card")
    .filter({ hasText: "Research workspace" });
  await second.getByRole("button", { name: "Sync now" }).click();
  const first = page
    .locator(".connection-card")
    .filter({ hasText: "Development workspace" });
  await first.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    first.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  await first.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page
    .getByLabel("Filter connection")
    .selectOption({ label: "Research workspace" });
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(
    page
      .locator(".stat")
      .filter({ hasText: "User + assistant messages" })
      .locator(".stat-value"),
  ).toHaveText("2");
  await page.getByLabel("Filter connection").selectOption("");
  await page.getByLabel("Sort sessions").selectOption("recent");
  await expect(page.locator("tbody tr")).toHaveCount(8);
  await expect(page.locator(".recharts-surface").first()).toBeVisible();
  await page.screenshot({ path: "../data/qa/dashboard.png", fullPage: true });
  await page
    .getByRole("button", { name: /Compare worker architectures/ })
    .first()
    .click();
  await expect(
    page.getByText("Start with a durable outbox and measure queue age.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "../data/qa/conversation.png",
    fullPage: true,
  });
  await page.getByLabel("Close conversation").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Your agents, in focus." }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBeTruthy();
  await page.screenshot({ path: "../data/qa/mobile.png", fullPage: true });
  expect(errors).toEqual([]);
});
