import { test, expect } from "@playwright/test";
import path from "node:path";
import { appendFile } from "node:fs/promises";

test("CLI and Desktop share a source directory without mixing sessions", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Connections/ }).click();
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .first()
    .click();
  await page.getByRole("radio", { name: "Codex CLI", exact: true }).check();
  await page
    .getByText("Another profile or archived conversations", { exact: true })
    .click();
  await page.getByLabel("Connection name").fill("CLI manual-test fixture");
  await page
    .getByLabel("Sessions directory")
    .fill(path.resolve("../data/e2e-mixed"));
  await page.getByRole("dialog").getByRole("button", { name: "Check source", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "1 conversation found",
  );
  await page.screenshot({ path: "../data/qa/cli-connection.png" });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  const card = page
    .locator(".connection-card")
    .filter({ hasText: "CLI manual-test fixture" });
  await expect(card).toContainText("Codex CLI · Local transcript watcher");
  await card.getByRole("button", { name: "Sync now" }).click();
  const connections = await (await request.get("/api/connections")).json();
  const cli = connections.find(
    (c: { name: string }) => c.name === "CLI manual-test fixture",
  );
  const desktop = await (
    await request.post("/api/connections", {
      data: {
        name: "Desktop mixed fixture",
        provider: "codex",
        path: path.resolve("../data/e2e-mixed"),
      },
    })
  ).json();
  await request.post(`/api/connections/${desktop.id}/sync`);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByLabel("Filter connection").selectOption(cli.id);
  await expect(
    page
      .getByRole("button", {
        name: /Mixed source cli conversation/,
      })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /Mixed source desktop conversation/,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: /Mixed source cli conversation/ })
    .first()
    .click();
  await page
    .locator("details")
    .filter({ hasText: "Synthetic workspace" })
    .locator("summary")
    .click();
  await expect(
    page.getByText("Synthetic workspace", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: /^Connections/ }).click();
  await card.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  await appendFile(
    path.resolve("../data/e2e-mixed/cli.jsonl"),
    JSON.stringify({
      type: "response_item",
      timestamp: new Date().toISOString(),
      payload: {
        type: "message",
        role: "assistant",
        content: "CLI live follow-up",
      },
    }) + "\n",
  );
  expect((await request.post(`/api/connections/${cli.id}/sync`)).status()).toBe(
    409,
  );
  await card.getByRole("button", { name: "Resume", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/metrics?connection=${cli.id}`)).json())
          .messages,
    )
    .toBe(2);
  expect(
    (await (await request.get(`/api/metrics?connection=${desktop.id}`)).json())
      .messages,
  ).toBe(1);
  await page.screenshot({
    path: "../data/qa/connection-identities.png",
    fullPage: true,
  });
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  const confirmation = page.getByRole("dialog");
  await expect(confirmation).toContainText("CLI manual-test fixture");
  await expect(confirmation).toContainText("will not be deleted");
  await page.screenshot({ path: "../data/qa/delete-connection.png" });
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(card).toBeVisible();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByLabel("Filter connection").selectOption("");
  await page.screenshot({
    path: "../data/qa/session-identities.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.locator(".session-panel .provider.codex_cli").first(),
  ).toBeVisible();
  await expect(
    page
      .locator(".session-connection-mobile")
      .filter({ hasText: "CLI manual-test fixture" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../data/qa/session-identities-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel("Filter connection").selectOption(cli.id);
  await page.getByRole("button", { name: /^Connections/ }).click();
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await confirmation
    .getByRole("button", { name: "Delete connection", exact: true })
    .click();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.getByLabel("Filter connection")).toHaveValue("");
  expect(
    (await (await request.get(`/api/metrics?connection=${desktop.id}`)).json())
      .messages,
  ).toBe(1);
  const restored = await request.post("/api/connections", {
    data: {
      name: "Restored CLI",
      provider: "codex_cli",
      path: path.resolve("../data/e2e-mixed"),
    },
  });
  expect(restored.status()).toBe(201);
  const restoredId = (await restored.json()).id;
  await request.post(`/api/connections/${restoredId}/sync`);
  expect(
    (await (await request.get(`/api/metrics?connection=${restoredId}`)).json())
      .messages,
  ).toBe(2);
});
