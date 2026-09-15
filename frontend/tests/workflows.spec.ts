import { test, expect } from "@playwright/test";
import path from "node:path";
import {
  categoricalSeries,
  cumulativeSegments,
  CHART_PALETTE,
} from "../src/chartSeries";
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
    .first()
    .click();
  await page.getByLabel("Connection name").fill("Development workspace");
  await page
    .getByLabel("Sessions directory")
    .fill(path.resolve("../data/e2e-source"));
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add connection", exact: true })
    .first()
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
    page
      .locator(".selection-summary")
      .filter({ hasText: "1 session selected" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".stat")
      .filter({
        has: page.locator(".stat-label").getByText("Messages", { exact: true }),
      })
      .locator(".stat-value"),
  ).toHaveText("11");
  await expect(
    page.getByLabel("Bucket size").locator("option:checked"),
  ).toContainText("1 minute");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pan earlier", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Pan earlier", exact: true }).click();
  await page.getByRole("button", { name: "Reset zoom", exact: true }).click();
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await page.getByLabel("Bucket size", { exact: true }).selectOption("60");
  await expect(page.getByLabel("Bucket size")).toHaveValue("60");
  await expect(page.locator(".window-caption")).toContainText(
    "600-bucket window",
  );
  await page.getByRole("button", { name: "Pan earlier", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pan later", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("Bucket size", { exact: true })).toHaveValue(
    "60",
  );
  await page.getByLabel("Vertical scale").selectOption("linear");
  await expect(page.getByLabel("Vertical scale")).toHaveValue("linear");
  await page.getByLabel("Vertical scale").selectOption("log");
  await page.getByRole("button", { name: "Reset zoom", exact: true }).click();
  await page.getByRole("button", { name: "Inspect activity" }).click();
  await page.getByRole("button", { name: "Next contributors" }).click();
  await expect(page.locator(".contribution-panel small")).toContainText(
    "6–7 of 7",
  );
  await page.getByRole("button", { name: "Previous contributors" }).click();
  const firstBucket = await page
    .getByLabel("Inspect time bucket")
    .locator("option")
    .nth(1)
    .getAttribute("value");
  await page.getByLabel("Inspect time bucket").selectOption(firstBucket!);
  await expect(page.locator(".contribution-heading")).toContainText(
    "Sessions in this bucket",
  );
  await page.getByRole("button", { name: "Clear bucket", exact: true }).click();
  const plot = page.getByTestId("actions-chart");
  await plot.scrollIntoViewIfNeeded();
  const bounds = (await plot.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + 70);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + 70, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Reset zoom", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Reset zoom", exact: true }).click();
  const navigator = page.getByLabel("Timeline overview");
  const beforePoints = await navigator
    .locator("polygon")
    .first()
    .getAttribute("points");
  const handle = page.getByRole("slider", {
    name: "Range end handle",
    exact: true,
  });
  const oldEnd = await handle.getAttribute("aria-valuenow");
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(handle).not.toHaveAttribute("aria-valuenow", oldEnd!);
  await expect(navigator.locator("polygon").first()).toHaveAttribute(
    "points",
    beforePoints!,
  );
  await expect(
    page.getByRole("button", { name: "Reset zoom", exact: true }),
  ).toBeEnabled();
  const startHandle = page.getByRole("slider", {
    name: "Range start handle",
    exact: true,
  });
  const oldStart = await startHandle.getAttribute("aria-valuenow");
  const handleBox = (await startHandle.boundingBox())!;
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 100, handleBox.y + 10, { steps: 6 });
  await page.mouse.up();
  await expect(startHandle).not.toHaveAttribute("aria-valuenow", oldStart!);
  const pan = page.getByRole("slider", {
    name: "Move time window",
    exact: true,
  });
  const beforePan = await pan.getAttribute("aria-valuenow");
  await pan.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(pan).not.toHaveAttribute("aria-valuenow", beforePan!);

  await page.getByRole("button", { name: "Reset zoom", exact: true }).click();
  const clear = page.getByRole("button", { name: "Clear all", exact: true });
  const clearBefore = await clear.boundingBox();
  await page
    .getByLabel("Session type", { exact: true })
    .selectOption("subagent");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText(
    "Repository access review",
  );
  expect((await clear.boundingBox())!.x).toBe(clearBefore!.x);
  await clear.click();
  await expect(page.getByLabel("Session type", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.locator("tbody tr")).toHaveCount(7);
  await expect(clear).toBeDisabled();
  await page.locator(".advanced-filters > summary").click();
  await page.getByLabel("Include internal reviews").check();
  await expect(page.locator("tbody tr")).toHaveCount(8);
  await page.getByLabel("Include internal reviews").uncheck();
  await expect(page.locator("tbody tr")).toHaveCount(7);
  await page.getByLabel("Search conversations", { exact: true }).fill("dance");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody mark")).toContainText(["dance"]);
  await page
    .getByRole("button", { name: /Repository access review/ })
    .first()
    .click();
  await expect(page.locator(".message")).toHaveCount(1);
  await expect(page.locator(".message mark")).toHaveText("dance");
  await page.keyboard.press("Escape");
  await page.getByLabel("Search matching").selectOption("contains");
  await expect(page.locator("tbody tr")).toHaveCount(7);
  await page.getByLabel("Clear search", { exact: true }).click();
  await page.getByLabel("Search matching").selectOption("words");
  await page.locator(".advanced-filters > summary").click();
  await page
    .getByLabel("Action filter", { exact: true })
    .selectOption("deletion");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page
    .getByRole("button", { name: /Repository access review/ })
    .first()
    .click();
  await expect(page.locator(".message")).toHaveCount(1);
  await page.getByRole("dialog").locator("summary").click();
  await expect(page.getByRole("dialog").locator("pre")).toContainText(
    "Remove-Item",
  );
  await page.keyboard.press("Escape");
  await page.getByLabel("Action filter", { exact: true }).selectOption("");
  await page.locator(".range-picker > summary").click();
  const today = new Date().toLocaleDateString("en-CA");
  await page.getByLabel("Range start", { exact: true }).fill(`${today}T00:00`);
  await page.getByLabel("Range end", { exact: true }).fill(`${today}T23:59`);
  await page.getByRole("button", { name: "Apply range" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.locator(".range-picker > summary").click();
  await page.getByRole("button", { name: "All time", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(7);

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
  await expect(page.locator(".message mark")).toContainText(["migration"]);
  await page
    .getByRole("button", { name: "Show surrounding conversation" })
    .click();
  await expect(
    page.getByText("Please explain step 1.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Filter event type").selectOption("tool_call");
  await expect(page.locator(".message")).toHaveCount(2);
  await page.getByRole("dialog").locator("summary").first().click();
  await expect(page.locator("pre").first()).toContainText("README.md");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("Clear search", { exact: true }).click();
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .first()
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
    .first()
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
      .filter({
        has: page.locator(".stat-label").getByText("Messages", { exact: true }),
      })
      .locator(".stat-value"),
  ).toHaveText("2");
  await page.getByLabel("Filter connection").selectOption("");
  await page.getByLabel("Sort sessions").selectOption("recent");
  await expect(page.locator("tbody tr")).toHaveCount(8);
  await expect(page.locator(".recharts-surface").first()).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(
    (await page.locator(".session-panel .panel-heading").boundingBox())!.y,
  ).toBeLessThan(1000);
  await expect(page.locator(".contribution-panel")).toHaveCount(0);
  await expect(
    page.getByTestId("messages-chart").locator(".recharts-bar"),
  ).toHaveCount(2);
  for (const kind of ["actions", "messages"]) {
    const chart = page.getByTestId(`${kind}-chart`);
    for (const bar of await chart.locator(".recharts-bar-rectangle").all()) {
      const box = await bar.boundingBox();
      if (box && box.height > 1) {
        await bar.hover();
        break;
      }
    }
    const tip = chart.locator(".signal-tooltip");
    await expect(tip).toBeVisible();
    const keys = tip.locator(".chart-color-key");
    await expect(keys).toHaveCount(2);
    const colors = await keys.evaluateAll((items) =>
      items.map((el) => getComputedStyle(el).backgroundColor),
    );
    expect(new Set(colors).size).toBe(2);

    if (kind === "actions") await expect(tip).toContainText("read_file");
    else {
      await expect(tip).toContainText("User");
      await expect(tip).toContainText("Assistant");
    }
    await page.screenshot({ path: `../data/qa/${kind}-tooltip.png` });
  }
  await page.mouse.move(0, 0);
  await page.screenshot({ path: "../data/qa/dashboard.png", fullPage: true });
  await page.locator("tbody tr").last().scrollIntoViewIfNeeded();
  const sticky = await page.locator(".sticky-controls").boundingBox();
  expect(sticky!.y).toBeGreaterThanOrEqual(0);
  expect(sticky!.y).toBeLessThan(10);
  await expect(
    page.getByRole("button", { name: "Clear all", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: "../data/qa/sticky-controls.png" });
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  await expect(page.getByLabel("Select visible sessions")).toHaveCount(0);
  await page
    .getByRole("button", { name: /Compare worker architectures/ })
    .first()
    .click();
  await expect(page.locator(".explorer-detail-heading")).toContainText(
    "Compare worker architectures",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({ path: "../data/qa/explorer.png", fullPage: true });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
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
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBeTruthy();
  await page.screenshot({ path: "../data/qa/mobile.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("categorical colors remain stable and overflow preserves counts", () => {
  const names = Array.from(
    { length: 12 },
    (_, i) => `tool-${i.toString().padStart(2, "0")}`,
  );
  const series = categoricalSeries("test-palette", names);
  expect(CHART_PALETTE).toHaveLength(10);
  expect(series).toHaveLength(10);
  expect(new Set(series.map((s) => s.color)).size).toBe(10);
  expect(series.flatMap((s) => s.members).sort()).toEqual(names);
  expect(series.at(-1)?.label).toBe("Other tools");
  const one = categoricalSeries("test-palette", [names[3]])[0];
  expect(one.color).toBe(
    series.find((s) => s.members.includes(names[3]))!.color,
  );
  const parts = cumulativeSegments([0, 2, 5, 1000], (n) => Math.log10(1 + n));
  expect(parts.every((n) => n >= 0)).toBeTruthy();
  expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(Math.log10(1008));
});
