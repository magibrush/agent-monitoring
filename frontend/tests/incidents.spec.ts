import { test, expect } from "@playwright/test";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

test("save from history, attach evidence, take notes, dismiss and restore", async ({
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
    await page.locator(".incident-history-action > summary").click();
    await page
      .getByRole("button", { name: "Save for review", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Check the configuration reads");
    await page
      .getByRole("button", { name: "Save request", exact: true })
      .click();
    const investigation = page.getByLabel("Attention details", {
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
    await investigation
      .getByText("Notes and activity", { exact: true })
      .click();
    await page
      .getByLabel("Add a note", { exact: true })
      .fill(
        "These are dummy files. Confirm the task scope before changing the rule.",
      );
    await page.getByRole("button", { name: "Save note", exact: true }).click();
    await expect(
      investigation
        .locator(".attention-activity")
        .filter({ hasText: "These are dummy files." }),
    ).toContainText("These are dummy files.");
    await page
      .getByRole("button", { name: "Add requests from history", exact: true })
      .click();
    await page
      .getByLabel("Safety actions", { exact: true })
      .getByRole("button")
      .nth(1)
      .click();
    await page.locator(".incident-history-action > summary").click();
    await page
      .getByRole("button", { name: "Save for review", exact: true })
      .click();
    await page.getByLabel("Save to", { exact: true }).selectOption(id);
    await page
      .getByRole("button", { name: "Attach action", exact: true })
      .click();
    await expect(investigation.getByText(/^2 requests ·/)).toBeVisible();
    await page.reload();
    await expect(investigation.getByText(/^2 requests ·/)).toBeVisible();
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
    await investigation
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await expect(investigation.getByRole("status")).toContainText("Dismissed.");
    await investigation
      .getByRole("button", { name: "Show again", exact: true })
      .click();
    await investigation.locator(".attention-evidence-toggle").first().click();
    await page
      .getByRole("button", { name: /^Detach action/ })
      .first()
      .click();
    await expect(investigation.getByText(/^1 request ·/)).toBeVisible();
    await investigation.locator(".attention-evidence-toggle").first().click();
    await page
      .getByRole("link", { name: "Open conversation", exact: false })
      .click();
    await expect(page.locator(".conversation-content")).toContainText(
      "Check the configuration using dummy test files.",
    );
    await page.goto(`/#safety?incident=${id}`);
    await page
      .getByRole("button", { name: "Back to list", exact: true })
      .click();
    await page
      .getByLabel("Find an item", { exact: true })
      .fill("Check the configuration reads");
    await expect(page.locator(".attention-row")).toHaveCount(1);
    await page.screenshot({
      path: "../data/qa/incident-inbox-mobile.png",
      fullPage: true,
    });
    await page
      .getByLabel("Find an item", { exact: true })
      .fill("missing fixture");
    await expect(
      page.getByText("No matching items", { exact: true }),
    ).toBeVisible();
  } finally {
    await request.delete(`/api/connections/${connection.id}`).catch(() => {});
  }
});

test("review the matching rule, test affected requests, and observe after applying", async ({
  page,
  request,
}) => {
  const failures: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 500) failures.push(response.url());
  });
  const fixture = JSON.parse(
    execFileSync(
      path.resolve("../.venv/Scripts/python.exe"),
      ["-m", "backend.tests.seed_attention_e2e"],
      { cwd: path.resolve(".."), encoding: "utf8" },
    ),
  );
  try {
    await page.goto(`/#safety?incident=${fixture.incident}`);
    const detail = page.getByLabel("Attention details", { exact: true });
    await expect(
      detail.getByRole("heading", {
        name: "3 matching requests needed a decision",
      }),
    ).toBeVisible();
    await expect(detail).toContainText("Review documentation reads");
    await page.screenshot({
      path: "../data/qa/attention-rule-desktop.png",
      fullPage: true,
    });
    await detail
      .getByRole("button", { name: "Review rule", exact: true })
      .click();
    await expect(page.getByLabel("Rule name", { exact: true })).toHaveValue(
      "Review documentation reads",
    );
    await expect(
      page.getByRole("button", { name: "Test affected requests" }),
    ).toBeDisabled();
    await page.getByLabel("Then", { exact: true }).selectOption("judge");
    await page.getByRole("button", { name: "Save rule", exact: true }).click();
    await page.getByRole("button", { name: "Test affected requests" }).click();
    await expect(page.locator(".attention-preview")).toContainText(
      "3 send to judge",
    );
    await page
      .getByText("Request-by-request comparison", { exact: true })
      .click();
    await expect(
      page.locator(".attention-preview .attention-activity"),
    ).toHaveCount(3);
    await page.screenshot({
      path: "../data/qa/attention-policy-preview.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: "../data/qa/attention-policy-mobile.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Apply anyway", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Back to Needs attention", exact: true })
      .click();
    await expect(detail.locator(".attention-followup")).toContainText(
      "No later assessments",
    );
    expect(failures).toEqual([]);
    await detail.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(detail.getByRole("status")).toContainText("Dismissed.");
  } finally {
    await request.delete(`/api/connections/${fixture.connection}`);
    execFileSync(
      path.resolve("../.venv/Scripts/python.exe"),
      [
        "-m",
        "backend.tests.seed_attention_e2e",
        "cleanup",
        JSON.stringify(fixture),
      ],
      { cwd: path.resolve(".."), encoding: "utf8" },
    );
  }
});


test("service problems open recorded timing and protection settings", async ({ page, request }) => {
  const fixture = JSON.parse(execFileSync(path.resolve("../.venv/Scripts/python.exe"), ["-m", "backend.tests.seed_attention_e2e", "service"], { cwd: path.resolve(".."), encoding: "utf8" }));
  try {
    await page.goto(`/#safety?incident=${fixture.incident}`);
    const detail = page.getByLabel("Attention details", { exact: true });
    await expect(detail.getByRole("heading", { name: "3 requests ran into evaluation problems" })).toBeVisible();
    await detail.getByRole("button", { name: "See where time went" }).click();
    await expect(detail.getByText("Initial queue", { exact: true })).toBeVisible();
    await page.screenshot({ path: "../data/qa/attention-service.png", fullPage: true });
    await detail.getByRole("button", { name: "Open protection settings" }).click();
    await expect(page.getByRole("button", { name: "Close safety settings" })).toBeVisible();
  } finally {
    await request.delete(`/api/connections/${fixture.connection}`);
    execFileSync(path.resolve("../.venv/Scripts/python.exe"), ["-m", "backend.tests.seed_attention_e2e", "cleanup", JSON.stringify(fixture)], { cwd: path.resolve(".."), encoding: "utf8" });
  }
});
