import { test, expect } from "@playwright/test";

for (const choice of ["approve", "deny", "expired"] as const) {
  test(`human review ${choice}: assessed action and bounded decision`, async ({ page }) => {
    let decided = false;
    let submitted: unknown;
    const evaluation = {
      id: "synthetic-review", input_hash: "a".repeat(64), status: "awaiting_review", mode: "blocking",
      created_at: new Date().toISOString(), started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
      deadline: new Date(Date.now() + (choice === "expired" ? -1000 : 60000)).toISOString(),
      decision: null, decision_at: null, returned_at: null, human_decision: null, reviewed_at: null,
      model: "synthetic-judge", policy_version: "test", attempts: 1, error: null,
      rules: { decision: "review", findings: [] }, gate: null,
      result: { recommendation: "review", risk: "medium", reason: "Confirm the destination before proceeding.", evidence: [], missing_context: [], source: "judge" },
    };
    await page.route("**/api/safety/actions?**", route => {
      const waiting = new URL(route.request().url()).searchParams.get("safety_state") === "awaiting_review";
      return route.fulfill({ json: { total: waiting && !decided ? 1 : 0, items: waiting && !decided ? [{ event_id: 1, title: "Synthetic human approval", tool_name: "Bash", occurred_at: evaluation.created_at, safety_state: "awaiting_review", flagged: true, evaluation }] : [] } });
    });
    await page.route("**/api/safety/evaluations/synthetic-review", route => route.fulfill({ json: { ...evaluation, snapshot: { action: '{"command":"echo SYNTHETIC_REVIEW_ONLY"}', action_truncated: false }, attempt_history: [] } }));
    await page.route("**/api/safety/evaluations/synthetic-review/review", route => {
      submitted = route.request().postDataJSON(); decided = true;
      return route.fulfill({ json: { ...evaluation, status: "completed", human_decision: choice } });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Safety", exact: true }).click();
    const queue = page.getByLabel("Awaiting human decisions");
    await expect(queue).toContainText("SYNTHETIC_REVIEW_ONLY");
    await expect(queue).toContainText("Confirm the destination");
    if (choice === "expired") {
      await expect(queue.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
      await expect(queue.getByRole("button", { name: "Deny", exact: true })).toBeDisabled();
      expect(submitted).toBeUndefined();
    } else {
      if (choice === "approve") {
        await page.screenshot({ path: "../data/qa/human-review-desktop.png", fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
        const approveBox = await queue.getByRole("button", { name: "Approve", exact: true }).boundingBox();
        expect(approveBox!.y + approveBox!.height).toBeLessThan(775);
        await page.screenshot({ path: "../data/qa/human-review-mobile.png", fullPage: true });
      }
      await queue.getByRole("button", { name: choice === "approve" ? "Approve" : "Deny", exact: true }).click();
      await expect(queue).toContainText("No actions waiting for approval");
      expect(submitted).toEqual({ decision: choice, input_hash: evaluation.input_hash });
    }
  });
}
