import { test, expect } from "@playwright/test";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

test("investigate from history, attach evidence, take notes, resolve and reopen", async ({
  page,
  request,
}) => {
  const root = path.resolve("../data/e2e-incidents/sessions");
  await mkdir(root, { recursive: true });
  const at = new Date().toISOString();
  await writeFile(
    path.join(root, "incident.jsonl"),
    [
      {
        type: "session_meta",
        timestamp: at,
        payload: {
          id: "incident-session",
          originator: "codex-tui",
          source: "cli",
        },
      },
      {
        type: "response_item",
        timestamp: at,
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Check the configuration using dummy test files.",
            },
          ],
        },
      },
      ...[".env.production", ".env.example", "settings.json"].map(
        (file, i) => ({
          type: "response_item",
          timestamp: at,
          payload: {
            type: "function_call",
            name: "read_file",
            call_id: `incident-${i}`,
            arguments: JSON.stringify({ path: `D:/fictional-project/${file}` }),
          },
        }),
      ),
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  const connection = await (
    await request.post("/api/connections", {
      data: {
        name: "Incident browser fixture",
        provider: "codex_cli",
        path: root,
      },
    })
  ).json();
  try {
    await request.post(`/api/connections/${connection.id}/sync`);
    const actions = (
      await (
        await request.get(`/api/safety/actions?connection=${connection.id}`)
      ).json()
    ).items;
    expect(actions).toHaveLength(3);
    await page.goto("/#safety");
    await page
      .getByRole("button", { name: "Action history", exact: true })
      .click();
    await page
      .getByLabel("Filter connection", { exact: true })
      .selectOption(connection.id);
    await page
      .getByLabel("Safety actions", { exact: true })
      .getByRole("button")
      .first()
      .click();
    await page
      .getByRole("button", { name: "Add to incident", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Check the configuration reads");
    await page
      .getByRole("button", { name: "Create incident", exact: true })
      .click();
    const investigation = page.getByLabel("Incident investigation", {
      exact: true,
    });
    await expect(
      investigation.getByRole("heading", {
        name: "Check the configuration reads",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page).toHaveURL(/incident=/);
    const id = new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get(
      "incident",
    )!;
    await page
      .getByRole("button", { name: "Start investigating", exact: true })
      .click();
    await expect(
      investigation.getByText("Investigating", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Add a note", { exact: true })
      .fill(
        "These are dummy files. Confirm the task scope before changing the rule.",
      );
    await page.getByRole("button", { name: "Save note", exact: true }).click();
    await expect(page.getByLabel("Investigation notes")).toContainText(
      "These are dummy files.",
    );
    await page
      .getByRole("button", { name: "Attach from history", exact: true })
      .click();
    await page
      .getByLabel("Safety actions", { exact: true })
      .getByRole("button")
      .nth(1)
      .click();
    await page
      .getByRole("button", { name: "Add to incident", exact: true })
      .click();
    await page.getByLabel("Incident", { exact: true }).selectOption(id);
    await page
      .getByRole("button", { name: "Attach action", exact: true })
      .click();
    await expect(
      investigation.getByText("2 linked requests", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      investigation.getByText("2 linked requests", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "../data/qa/incidents-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: "../data/qa/incidents-mobile.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Resolve incident", exact: true })
      .click();
    await page
      .getByLabel("How did this turn out?", { exact: true })
      .selectOption("expected");
    await page
      .getByRole("button", { name: "Save resolution", exact: true })
      .click();
    await expect(
      investigation.getByText("Expected activity", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Reopen incident", exact: true })
      .click();
    await expect(
      investigation.getByText("Investigating", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /^Detach action/ })
      .first()
      .click();
    await expect(
      investigation.getByText("1 linked request", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "Open conversation", exact: false })
      .click();
    await expect(page.locator(".conversation-content")).toContainText(
      "Check the configuration using dummy test files.",
    );
    await page.goto(`/#safety?incident=${id}`);
    await page
      .getByRole("button", { name: "All incidents", exact: true })
      .click();
    await page
      .getByLabel("Find an incident", { exact: true })
      .fill("Check the configuration reads");
    await expect(page.locator(".incident-row")).toHaveCount(1);
    await page.screenshot({
      path: "../data/qa/incident-inbox-mobile.png",
      fullPage: true,
    });
    await page
      .getByLabel("Find an incident", { exact: true })
      .fill("missing fixture");
    await expect(
      page.getByText("No incidents match", { exact: true }),
    ).toBeVisible();
  } finally {
    await request.delete(`/api/connections/${connection.id}`).catch(() => {});
  }
});
