import { expect, test, type Page } from "@playwright/test";

async function tour(page: Page, capture: (name: string) => Promise<void>) {
  const coach = page.getByRole("dialog", { name: "Guided demo" });
  await expect(
    coach.getByRole("heading", { name: "Your agents at a glance" }),
  ).toBeVisible();
  await coach.getByRole("button", { name: "Find a session" }).click();
  await expect(
    coach.getByRole("heading", { name: "Open a session" }),
  ).toBeVisible();
  // No direct route changes: each action is taken through the actual application.
  await page.locator('[data-tour-session="demo-upload"]').click();
  await expect(page).toHaveURL(/#explorer\?session=demo-upload/);
  await expect(
    page
      .locator(".message-text")
      .filter({ hasText: "Count rows in fixtures/customers.csv" }),
  ).toBeVisible();
  await expect(
    coach.getByRole("button", { name: "Check the assessment" }),
  ).toBeDisabled();
  await coach
    .getByRole("button", { name: "Read conversation", exact: true })
    .click();
  await expect(
    coach.getByRole("button", { name: "Check the assessment" }),
  ).toBeHidden();
  await capture("guided-reading.png");
  await coach.getByRole("button", { name: "Show guide", exact: true }).click();
  await coach.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(coach.getByRole("status")).toContainText("local-only request");
  await coach.getByRole("button", { name: "Deny", exact: true }).click();
  await capture("guided-conversation.png");
  await coach.getByRole("button", { name: "Check the assessment" }).click();
  await page.locator('[data-tour-nav="safety"]').click();
  await page.locator('[data-tour-incident="demo-incident-upload"]').click();
  await expect(page.locator('[data-tour="incident-analysis"]')).toContainText(
    "Scripted demo analysis",
  );
  await coach.getByRole("button", { name: "Compare another incident" }).click();
  await expect(page).toHaveURL(/#safety$/);
  await expect(page.getByRole("region", { name: "Incident details", exact: true })).toHaveCount(0);
  await expect(coach.getByRole("heading", { name: "Compare a human review" })).toBeVisible();
  await capture("guided-compare.png");
  const nextIncident = page.locator('[data-tour-incident="demo-incident-push"]');
  await expect(nextIncident).toBeInViewport();
  // Click where the visitor sees the control, without locator auto-scrolling.
  const box = (await nextIncident.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page).toHaveURL(/#safety\?incident=demo-incident-push$/);
  await expect(coach.getByRole("heading", { name: "An action that needs permission" })).toBeVisible();
  await expect(page.locator('[data-tour="review-request"]')).toContainText("git push --force");
  await coach.getByRole("button", { name: "See the review decision" }).click();
  await expect(coach.getByRole("heading", { name: "Human review was requested" })).toBeVisible();
  await expect(page.locator('[data-tour="review-decision"]')).toContainText("Blocked by Relay");
  await expect(page.locator('[data-tour="review-decision"]')).toContainText("Relay denied permission for this action.");
  await expect(page.locator('[data-tour="action-open"]')).toBeHidden();
  if (page.viewportSize()!.width < 700) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(coach.getByRole("status")).toContainText("Highlight below");
    await expect(coach).not.toContainText("Finding the highlighted control");
    await expect.poll(async () => {
      const box = (await coach.boundingBox())!;
      return page.viewportSize()!.height - box.y - box.height;
    }).toBeLessThan(20);
    await capture("guided-offscreen.png");
    await coach.getByRole("button", { name: "Show highlight" }).click();
    await expect(coach.getByRole("status")).toHaveCount(0);
    await expect(page.locator('[data-tour="review-decision"]')).toBeInViewport();
  }
  await capture("guided-decision.png");
  await coach.getByRole("button", { name: "See the connections" }).click();
  await page.locator('[data-tour-nav="connections"]').click();
  await expect(page.locator(".demo-connection-card")).toHaveCount(3);
  await coach.getByRole("button", { name: "Finish and explore" }).click();
  await expect(coach).toHaveCount(0);
  await expect(page.locator(".tour-shade")).toHaveCount(0);
}

for (const size of ["desktop", "laptop", "mobile"]) {
  test(`actual application spotlight tour ${size}`, async ({
    page,
  }, testInfo) => {
    if (size === "mobile") await page.setViewportSize({ width: 390, height: 844 });
    if (size === "laptop") await page.setViewportSize({ width: 1366, height: 768 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.locator(".tour-spotlight")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("guided-overview.png") });
    await tour(page, async (name) => {
      await page.screenshot({ path: testInfo.outputPath(name) });
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: testInfo.outputPath("demo-connections.png"),
      fullPage: true,
    });
    // Finished tours stay out of the way on reload.
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Sample connections" }),
    ).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Guided demo" })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Restart guided tour" }).click();
    await expect(
      page.getByRole("heading", { name: "Your agents at a glance" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Guided demo" })).toHaveCount(
      0,
    );
    expect(errors).toEqual([]);
  });
}

test("free exploration, context labels, dismissal, and reset remain available", async ({
  page,
  request,
}, testInfo) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore freely", exact: true })
    .click();
  await page.screenshot({
    path: testInfo.outputPath("demo-overview.png"),
    fullPage: true,
  });
  await page.locator('[data-tour-nav="safety"]').click();
  await page.locator('[data-tour-incident="demo-incident-upload"]').click();
  await page.locator(".incident-timeline > summary").click();
  const context = page.locator(".incident-context details").first();
  await context.locator("summary").click();
  await expect(context.locator(".context-record-label").first()).toHaveText(
    "Context",
  );
  await expect(context.locator(".evidence-label")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("demo-incident.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Dismiss incident", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Dismiss incident", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get("/api/safety/incidents/demo-incident-upload")
          ).json()
        ).status,
    )
    .toBe("resolved");
  await page.getByRole("button", { name: "Reset demo", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your agents at a glance" }),
  ).toBeVisible();
  expect(
    (
      await (
        await request.get("/api/safety/incidents/demo-incident-upload")
      ).json()
    ).status,
  ).toBe("new");
});
