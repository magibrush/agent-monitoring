import { test, expect } from "@playwright/test";
import path from "node:path";
import { execFileSync } from "node:child_process";

function seed(kind = "") {
  return JSON.parse(
    execFileSync(
      path.resolve("../.venv/Scripts/python.exe"),
      ["-m", "backend.tests.seed_attention_e2e", ...(kind ? [kind] : [])],
      { cwd: path.resolve(".."), encoding: "utf8" },
    ),
  );
}
async function cleanup(request: any, fixture: any) {
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

test("automatic flagged allowance explains the conversation, outcome and cited next steps", async ({
  page,
  request,
}) => {
  const fixture = seed();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) errors.push(response.url());
  });
  try {
    await page.goto(`/#safety?incident=${fixture.incident}`);
    const detail = page.getByLabel("Incident details", { exact: true });
    await expect(
      detail.getByRole("heading", { name: "Allowed by the judge, flagged" }),
    ).toBeVisible();
    await expect(detail.locator(".incident-severity")).toHaveText(["Medium", "Medium"]);
    await expect(detail).toContainText("Git then rejected the push");
    await expect(
      detail.getByRole("heading", { name: "Suggested next steps" }),
    ).toBeVisible();
    await expect(detail.locator(".incident-conversation")).toContainText(
      "leave main alone",
    );
    await expect(detail.locator(".incident-conversation")).toContainText(
      "Release confirmed",
    );
    await expect(detail.locator(".incident-conversation")).toContainText(
      "Execution: failed",
    );
    await expect(
      detail.getByText("Notes and activity", { exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: "../data/qa/automated-incident-desktop.png",
      fullPage: true,
    });
    await detail.locator(".incident-citations button").first().click();
    await expect(
      detail.locator(".incident-conversation .highlighted"),
    ).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: "../data/qa/automated-incident-mobile.png",
      fullPage: true,
    });
    await detail
      .getByRole("button", { name: "Dismiss incident", exact: true })
      .click();
    await expect(detail.getByRole("status")).toContainText("Dismissed");
    await detail
      .getByRole("button", { name: "Show again", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Back to incidents", exact: true })
      .click();
    await page.getByLabel("Incident severity").selectOption("critical");
    await expect(
      page.getByText("No matching items", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Incident severity").selectOption("medium");
    await expect(page.locator(".attention-row")).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await cleanup(request, fixture);
  }
});

test("existing rule investigations retain their focused draft comparison", async ({
  page,
  request,
}) => {
  const fixture = seed("policy");
  try {
    await page.goto(`/#safety?incident=${fixture.incident}`);
    const detail = page.getByLabel("Incident details", { exact: true });
    await detail
      .getByRole("button", { name: "Review matching rule", exact: true })
      .click();
    await expect(page.getByLabel("Rule name", { exact: true })).toHaveValue(
      "Review documentation reads",
    );
    await page.getByLabel("Then", { exact: true }).selectOption("judge");
    await page.getByRole("button", { name: "Save rule", exact: true }).click();
    await page.getByRole("button", { name: "Test affected requests" }).click();
    await expect(page.locator(".attention-preview")).toContainText(
      "3 send to judge",
    );
    await page
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Apply anyway", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Back to Incidents", exact: true })
      .click();
    await expect(detail.locator(".attention-followup")).toContainText(
      "No later assessments",
    );
  } finally {
    await cleanup(request, fixture);
  }
});

test("service problems open recorded timing and protection settings", async ({
  page,
  request,
}) => {
  const fixture = seed("service");
  try {
    await page.goto(`/#safety?incident=${fixture.incident}`);
    const detail = page.getByLabel("Incident details", { exact: true });
    await expect(
      detail.getByRole("heading", {
        name: "3 requests ran into evaluation problems",
      }),
    ).toBeVisible();
    await detail.getByRole("button", { name: "See where time went" }).click();
    await expect(
      detail.getByText("Initial queue", { exact: true }),
    ).toBeVisible();
    await detail.getByRole("button", { name: "Protection settings" }).click();
    await expect(
      page.getByRole("button", { name: "Close safety settings" }),
    ).toBeVisible();
  } finally {
    await cleanup(request, fixture);
  }
});

test("missing credentials and failed refresh keep evidence usable without claiming progress", async ({
  page,
  request,
}) => {
  const fixture = seed();
  let state = "needs_key";
  try {
    await page.route(
      `**/api/safety/incidents/${fixture.incident}?*`,
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({
          response,
          json: {
            ...body,
            analysis: {
              ...body.analysis,
              status: state,
              stale: true,
              error:
                state === "failed"
                  ? "Analysis could not be completed. The recorded activity is still available."
                  : null,
            },
          },
        });
      },
    );
    await page.goto(`/#safety?incident=${fixture.incident}`);
    const detail = page.getByLabel("Incident details", { exact: true });
    await detail.getByRole("button", { name: "Open Safety settings" }).click();
    await page.getByRole("button", { name: "Close safety settings" }).click();
    await expect(detail.locator(".incident-conversation")).toContainText(
      "Release confirmed",
    );
    await page.screenshot({
      path: "../data/qa/automated-incident-needs-key.png",
      fullPage: true,
    });
    state = "failed";
    await page.reload();
    await expect(detail.getByRole("status")).toContainText(
      "could not be completed",
    );
    await expect(detail).not.toContainText("An updated analysis is queued");
    await expect(detail.locator(".incident-conversation")).toContainText(
      "leave main alone",
    );
  } finally {
    await cleanup(request, fixture);
  }
});
