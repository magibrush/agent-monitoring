import { test, expect } from "@playwright/test";

test("simple setup, archives, and conversation-colored bars", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Connections/ }).click();
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Connect an app" }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Connection name")).not.toBeVisible();
  await expect(dialog.getByLabel("Sessions directory")).not.toBeVisible();
  await expect(dialog.getByRole("status")).toContainText(
    "1 conversation found",
  );
  await page.screenshot({ path: "../data/qa/simple-setup.png" });
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: /^Connections/ }).click();
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .first()
    .click();
  await expect(
    dialog.getByRole("button", { name: "Already connected", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("radio", { name: "Codex CLI", exact: true }).check();
  await expect(dialog.getByRole("status")).toContainText(
    "1 conversation found",
  );
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const connections = await (await request.get("/api/connections")).json();
  const cli = connections.find((c: { name: string }) => c.name === "Codex CLI");
  const desktop = connections.find(
    (c: { name: string }) => c.name === "Codex Desktop",
  );
  await request.post(`/api/connections/${cli.id}/sync`);
  await request.post(`/api/connections/${desktop.id}/sync`);
  await page.getByRole("button", { name: /^Connections/ }).click();
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .first()
    .click();
  await dialog
    .getByText("Another profile or archived conversations", { exact: true })
    .click();
  await dialog
    .getByLabel("Archived conversations (separate connection)")
    .check();
  await expect(dialog.getByRole("status")).toContainText(
    "1 conversation found",
  );
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Codex Desktop · Archives",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByLabel("Filter connection").selectOption(cli.id);
  await page.getByLabel("Color bars by").selectOption("conversation");
  await expect(page.getByLabel("Vertical scale")).toHaveValue("linear");
  await expect(page.getByLabel("Vertical scale")).toBeDisabled();
  await expect(page.getByLabel("Conversation colors")).toHaveCount(0);
  await page.getByTestId("actions-chart").focus();
  await page.keyboard.press("Home");
  await expect(page.getByLabel("Bar inspection").locator("h3")).toHaveText("Actions");
  await page.getByLabel("Filter connection").selectOption("");
  await expect(page.getByLabel("Color bars by")).toHaveValue("conversation");
  await page.getByTestId("actions-chart").focus();
  await page.keyboard.press("Home");
  await page.screenshot({
    path: "../data/qa/conversation-bars.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../data/qa/conversation-bars-mobile.png",
    fullPage: true,
  });
  await page.getByLabel("Color bars by").selectOption("activity");
  await expect(page.getByLabel("Vertical scale")).toHaveValue("linear");
});
