import { test, expect } from "@playwright/test";

test("realistic safety layout, history scope, and flat action detail", async ({ page, request }) => {
  const base = await (await request.get("/api/metrics")).json();
  const now = Date.now(), start = now - 3600000;
  const reason = "The destination is outside the project workspace. The requested copy includes configuration files whose contents are not visible in this request. Confirm that the destination belongs to this test environment before allowing the transfer. This recommendation concerns the proposed copy, not the earlier conversation.";
  const evaluation = { id: "layout-1", input_hash: "b".repeat(64), mode: "blocking", status: "awaiting_review", created_at: new Date(now).toISOString(), started_at: new Date(now).toISOString(), completed_at: new Date(now).toISOString(), deadline: new Date(now + 60000).toISOString(), decision: null, gate: null, human_decision: null, reviewed_at: null, returned_at: null, decision_at: null, model: "synthetic", policy_version: "test", attempts: 1, rules: { decision: "review", findings: [] }, result: { recommendation: "review", risk: "medium", reason, evidence: ["Destination outside workspace"], missing_context: ["Destination ownership"], source: "judge" } };
  const live = [1, 2].map(n => ({ event_id: n, title: n === 1 ? "Test the configuration export in a temporary environment" : "Inspect the worker's file access", tool_name: n === 1 ? "Bash" : "Read", occurred_at: evaluation.created_at, safety_state: "awaiting_review", execution_outcome: "requested", evaluation: { ...evaluation, id: `layout-${n}` } }));
  const history = ["released", "denied", "error", "shadow", "unassessed"].map((state, i) => ({ event_id: i + 10, title: "Investigate worker setup", tool_name: "Bash", occurred_at: new Date(now - i * 600000).toISOString(), safety_state: state, execution_outcome: "requested", evaluation: state === "unassessed" ? null : { ...evaluation, id: `history-${i}`, status: "completed", mode: state === "shadow" ? "shadow" : "blocking", decision: state === "denied" ? "deny" : state === "error" ? "expired" : "pass", gate: state === "released" ? { decision: "pass" } : null, returned_at: state === "released" ? evaluation.created_at : null, result: { ...evaluation.result, recommendation: state === "denied" ? "deny" : "allow", reason: ["Reads the project README without changing files.", "Attempts to remove files outside the approved test directory.", "Approval deadline expired.", "Routine development activity; shadow assessment only."][i] } } }));
  await page.route("**/api/safety", route => route.fulfill({ json: { model: "Haiku", key_configured: true, workers: [{}], counts: { awaiting_review: 2 } } }));
  await page.route("**/api/metrics?**", route => route.fulfill({ json: { ...base, sessions: 1, actions: 5, safety: { released: 1, denied: 1, error: 1, shadow: 1, unassessed: 1 }, domain: { start: new Date(start).toISOString(), end: new Date(now).toISOString() }, viewport: { start: new Date(start).toISOString(), end: new Date(now).toISOString() }, interval_seconds: 600, series: history.map((item, i) => ({ time: start + i * 600000, actions: 1, user: 0, assistant: 0, safety: { [item.safety_state]: 1 }, tools: [] })) } }));
  await page.route("**/api/safety/actions?**", route => {
    const state = new URL(route.request().url()).searchParams.get("safety_state");
    const items = state === "awaiting_review" ? live : state ? history.filter(row => row.safety_state === state) : history;
    return route.fulfill({ json: { total: items.length, items } });
  });
  await page.route("**/api/safety/evaluations/*", route => {
    const id = route.request().url().split("/").pop();
    const e = [...live, ...history].find(row => row.evaluation?.id === id)?.evaluation;
    return route.fulfill({ json: { ...e, snapshot: { action: JSON.stringify({ tool_input: { command: "Copy-Item ./fixtures/*.json D:/temporary-test/export/", description: "Copy synthetic configuration fixtures" }, cwd: "D:/project" }), action_truncated: false }, attempt_history: [] } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Safety", exact: true }).click();
  const queue = page.getByLabel("Awaiting human decisions");
  await expect(queue.getByRole("button", { name: "Approve", exact: true })).toHaveCount(2);
  await page.screenshot({ path: "../data/qa/safety-realistic-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await queue.getByRole("button", { name: "Approve", exact: true }).first().boundingBox();
  expect(box!.y + box!.height).toBeLessThan(775);
  await page.screenshot({ path: "../data/qa/safety-realistic-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "Denied 1", exact: true }).click();
  await expect(page.getByLabel("Safety actions").getByRole("button")).toHaveCount(1);
  await expect(queue.getByRole("button", { name: "Approve", exact: true })).toHaveCount(2);
  await page.getByLabel("Safety actions").getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("Attempts to remove files");
  await expect(page.getByRole("dialog").locator("details")).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "../data/qa/safety-detail-simple.png" });
  await page.getByRole("button", { name: "Close action details" }).click();
});
