import { test, expect } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`tour keeps cited evidence in the spotlight at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    const guide = page.getByRole("dialog", { name: "Guided demo" });
    await guide.getByRole("button", { name: "Find a session" }).click();
    await page.locator('[data-tour-session="demo-upload"]').click();
    await guide.getByRole("button", { name: "Deny", exact: true }).click();
    await guide.getByRole("button", { name: "Check the assessment" }).click();
    await page.locator('[data-tour-nav="safety"]').click();
    await page.locator('[data-tour-incident="demo-incident-upload"]').click();
    await expect(guide).toContainText("A decision backed by evidence");
    await page.locator(".incident-citations button").first().click();
    const preview = page.getByRole("region", { name: /Evidence .* preview/ });
    await expect(preview).toBeVisible();
    await expect(preview.getByText("Flagged", { exact: true })).toHaveCount(0);
    await expect(preview.locator(".evidence-label")).toHaveCount(0);
    await expect(preview.locator(".evidence-risk")).toContainText("Critical risk");
    await expect(preview.getByLabel("Safety assessment")).toContainText("Scripted demo");
    await expect(preview.locator(".evidence-outcome")).toContainText("Blocked by Relay");
    await expect(preview.locator(".evidence-decision-details")).not.toHaveAttribute("open");
    await expect.poll(async () => {
      const box = await preview.boundingBox();
      const spot = await page.locator(".tour-spotlight").boundingBox();
      return !!box && !!spot && Math.abs(spot.x - Math.max(6, box.x - 6)) < 2 && Math.abs(spot.y - Math.max(6, box.y - 6)) < 2;
    }).toBe(true);
    await expect(preview).toBeFocused();
    await expect.poll(async () => {
      const card = await preview.boundingBox();
      const coach = await guide.boundingBox();
      return !!card && !!coach && (coach.y >= card.y + card.height || coach.y + coach.height <= card.y || coach.x + coach.width <= card.x || coach.x >= card.x + card.width);
    }).toBe(true);
    await page.screenshot({ path: `../data/qa/tour-evidence-${width}.png` });
    await preview.getByRole("button", { name: "Close evidence preview" }).click();
    await guide.getByRole("button", { name: "Compare another incident" }).click();
    await page.locator('[data-tour-incident="demo-incident-push"]').click();
    await expect(page.locator('[data-tour="review-request"]')).toBeVisible();
    await guide.getByRole("button", { name: "See the review decision" }).click();
    await expect(page.locator('[data-tour="review-decision"]')).toBeVisible();
  });
}

test("opening cited conversation exits the guided overlay", async ({ page }) => {
  await page.goto("/");
  const guide = page.getByRole("dialog", { name: "Guided demo" });
  await guide.getByRole("button", { name: "Find a session" }).click();
  await page.locator('[data-tour-session="demo-upload"]').click();
  await guide.getByRole("button", { name: "Deny", exact: true }).click();
  await guide.getByRole("button", { name: "Check the assessment" }).click();
  await page.locator('[data-tour-nav="safety"]').click();
  await page.locator('[data-tour-incident="demo-incident-upload"]').click();
  await page.locator(".incident-citations button").first().click();
  await page.locator("#incident-evidence-preview").getByRole("link", { name: "Open in conversation" }).click();
  await expect(guide).toBeHidden();
  await expect(page).toHaveURL(/#explorer/);
});

const outcomes = [
  { name: "permission without a result", receipt: "pass", state: "requested", mode: "blocking", status: "released", title: "Released" },
  { name: "failed action", receipt: "pass", state: "failed", mode: "blocking", status: "released", title: "Action failed" },
  { name: "completed action", receipt: "pass", state: "completed", mode: "blocking", status: "released", title: "Action completed" },
  { name: "human approval", state: "requested", mode: "blocking", status: "awaiting_review", title: "Waiting for your approval" },
  { name: "observation only", state: "requested", mode: "shadow", status: "pending", title: "Observed only" },
  { name: "missing receipt", state: "requested", mode: "blocking", status: "denied", title: "Outcome unknown" },
  { name: "conflicting result", receipt: "deny", state: "completed", mode: "blocking", status: "denied", title: "Conflicting records" },
];

for (const scenario of outcomes) {
  test(`evidence explains ${scenario.name} without conflating permission and execution`, async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem("relay-guided-demo-finished", "yes"));
    await page.route("**/api/safety/incidents/demo-incident-upload?*", async route => {
      const response = await route.fetch();
      const data = await response.json();
      data.analysis.model = "test-model";
      for (const event of data.timeline.events) {
        if (!event.assessment) continue;
        event.gate = { mode: scenario.mode, status: scenario.status, receipt_decision: scenario.receipt, returned_at: scenario.receipt ? new Date().toISOString() : null };
        event.execution = { hook_state: scenario.state };
      }
      await route.fulfill({ response, json: data });
    });
    await page.goto("/#safety?incident=demo-incident-upload");
    await page.locator(".incident-citations button").first().click();
    const preview = page.locator("#incident-evidence-preview");
    await expect(preview.locator(".verdict-tile").last().locator(".decision-status")).toHaveText(scenario.title);
    await expect(preview.getByLabel("Safety assessment")).toContainText("Judge LLM");
    await preview.locator(".evidence-decision-details > summary").click();
    await expect(preview.getByText("Execution record", { exact: true })).toBeVisible();
    if (scenario.state === "requested") await expect(preview).toContainText("This does not prove whether the action ran.");
  });
}
