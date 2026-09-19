import { test, expect } from "@playwright/test";

test("policy results filter, search beyond ten, paginate and inspect evidence", async ({ page }) => {
  const rule = { schema_version: 2, id: "shell", name: "Review shell commands", enabled: true, connection_ids: [], activity: "shell", roots: [], extensions: [], filenames: [], tool_name: "", command_contains: "", effect: "review", expires_at: null };
  const items = Array.from({ length: 45 }, (_, i) => ({ evaluation_id: `sample-${i}`, tool: "Bash", title: `Synthetic session ${i}`, connection_name: "CLI test connection", occurred_at: new Date(2026, 8, 19, 12, i).toISOString(), action: JSON.stringify({ cwd: "D:/Example", tool_name: "Bash", tool_input: { command: i === 42 ? "git push origin release-42" : `git status --short # sample ${i}` } }), previous_decision: "allow", decision: i % 2 ? "deny" : "review", reason: i % 2 ? "Block sensitive-file access" : "Review shell commands", explanation: "The requested tool is Bash, so it matches the shell activity rule. Human approval takes priority over automatic approval.", conditions: ["Activity: shell", "Connections: all"], rule_ids: ["shell"], matched_rules: [{ id: "shell", name: "Review shell commands", effect: "review", conditions: ["All shell commands", "All connections"] }], winner_id: "shell" }));
  await page.route("**/api/safety/policies", route => route.fulfill({ json: { revision: 1, active_id: null, paused_id: null, trial_id: null, draft_id: 1, changes: [], versions: [{ id: 1, name: "Working draft", rules: [rule], created_at: new Date().toISOString(), previewed_at: new Date().toISOString(), preview_result: { sampled: 45, counts: { review: 23, deny: 22 }, examples: [] }, ever_active: false, conflicts: [], overlaps: [] }] } }));
  await page.route("**/api/safety/policies/versions/1/results?**", route => {
    const params = new URL(route.request().url()).searchParams, q = params.get("q") ?? "", outcome = params.get("decision"), offset = Number(params.get("offset"));
    const filtered = items.filter(i => (!outcome || outcome === "all" || i.decision === outcome) && JSON.stringify(i).toLowerCase().includes(q.toLowerCase()));
    return route.fulfill({ json: { items: filtered.slice(offset, offset + 20), total: filtered.length, sampled: 45, counts: { review: 23, deny: 22, allow: 0, judge: 0, none: 0, unavailable: 0 }, offset, limit: 20, cap: 500, tested_at: "2026-09-19T12:00:00Z" } });
  });
  await page.goto("/#safety"); await page.getByRole("button", { name: "Policies", exact: true }).click();
  const results = page.getByLabel("Policy test results");
  await expect(results.getByText("1–20 of 45", { exact: true })).toBeVisible();
  await results.getByRole("button", { name: "Next test results", exact: true }).click();
  await expect(results.getByText("21–40 of 45", { exact: true })).toBeVisible();
  await results.getByRole("button", { name: "Block 22", exact: true }).click();
  await expect(results.getByText("1–20 of 22", { exact: true })).toBeVisible();
  await results.getByRole("button", { name: "All 45", exact: true }).click();
  await results.getByRole("textbox", { name: "Search test results" }).fill("release-42");
  await expect(results.getByText("1–1 of 1", { exact: true })).toBeVisible();
  await results.getByRole("button", { name: /git push origin release-42/ }).click();
  await expect(page.getByLabel("Test request details")).toContainText("Human approval takes priority");
  await expect(page.getByLabel("Test request details")).toContainText("Recorded assessment");
  await page.screenshot({ path: "../data/qa/policy-results-desktop.png", fullPage: true });
  await results.getByRole("textbox", { name: "Search test results" }).fill("does-not-exist");
  await expect(results.getByText("No results match these filters.")).toBeVisible();
  await expect(page.getByLabel("Test request details")).toContainText("Select a request");
  await page.setViewportSize({ width: 390, height: 844 });
  await results.getByRole("textbox", { name: "Search test results" }).fill("release-42");
  await results.getByRole("button", { name: /git push origin release-42/ }).click();
  await expect(page.getByLabel("Test request details")).toContainText("git push origin release-42");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: "../data/qa/policy-results-mobile.png", fullPage: true });
});
