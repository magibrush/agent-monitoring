import { test, expect } from "@playwright/test";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

test("blocking denial, safety chart filtering, evidence and mobile layout", async ({ page, request }) => {
  const root = path.resolve("../data/e2e-safety-profile/sessions");
  await mkdir(root, { recursive: true });
  const transcript = path.join(root, "safety.jsonl");
  const timestamp = new Date().toISOString();
  await writeFile(transcript, [
    { type: "session_meta", timestamp, payload: { id: "safety-session", originator: "codex-tui", source: "cli" } },
    { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Safety browser fixture" }] } },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  const connection = await (await request.post("/api/connections", { data: { name: "Safety test", provider: "codex_cli", path: root } })).json();
  try {
    await request.post(`/api/connections/${connection.id}/sync`);
    await page.goto("/");
    await page.getByRole("button", { name: "Safety", exact: true }).click();
    await page.getByRole("button", { name: "Action history", exact: true }).click();
    await expect(page.getByLabel("Safety evaluation status")).toContainText("Waiting for judge API key");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const card = page.locator(".safety-setting-row").filter({ hasText: "Safety test" });
    await page.getByRole("button", { name: "Configure protection for Safety test" }).click();
    await page.getByRole("radio", { name: /Block risky actions/ }).check();
    await expect(page.getByRole("dialog")).toContainText("Timeouts block");
    await page.getByRole("button", { name: "Enable live hooks", exact: true }).click();
    await expect(card).toContainText("Blocking configured");
    await page.getByRole("button", { name: "Close safety settings" }).click();
    // Only send the proposed command as JSON to the gate; never execute it.
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(path.resolve("../.venv/Scripts/python.exe"), [path.resolve("../scripts/gate_hook.py"), path.resolve(`../data/hook-queue/${connection.id}`), "codex_cli", root]);
      child.on("error", reject); child.on("exit", resolve);
      child.stdin.end(JSON.stringify({ session_id: "safety-session", transcript_path: transcript, cwd: root, hook_event_name: "PreToolUse", tool_use_id: "safety-call", tool_name: "Bash", tool_input: { command: "rm -rf /" } }));
    });
    expect(code).toBe(2);
    await expect.poll(async () => (await (await request.get(`/api/metrics?connection=${connection.id}`)).json()).actions).toBe(1);
    await page.getByLabel("Filter connection").selectOption(connection.id);
    await expect(page.getByLabel("Color bars by")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Messages", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Denied 1", exact: true }).click();
    await expect(page.getByRole("button", { name: "Denied 1", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Safety actions").getByRole("button")).toHaveCount(1);
    await page.getByLabel("Safety actions").getByRole("button").click();
    await expect(page.getByLabel("Action details", { exact: true })).toContainText("Explicit policy prohibition");
    await expect(page.getByLabel("Action details", { exact: true })).toContainText("Hook returned");
    await page.screenshot({ path: "../data/qa/safety-detail-simple.png" });
    await page.getByRole("button", { name: "Close action details" }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "../data/qa/blocking-safety-chart.png", fullPage: true });
    await page.getByRole("button", { name: "Released 0", exact: true }).click();
    await expect(page.getByLabel("Safety actions")).toContainText("No actions in this selection");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "../data/qa/safety-workspace-mobile.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Connections", exact: false }).first().click();
    await expect(page.getByLabel("Safety evaluation status")).toHaveCount(0);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByLabel("Filter connection").selectOption(connection.id);
    await page.getByRole("button", { name: /Safety browser fixture/ }).first().click();
    await expect(page.locator(".safety-verdict > strong")).toHaveText("Denied");
    await expect(page.locator(".safety-verdict")).toContainText("Gate returned deny");
    await expect(page.locator(".safety-verdict")).not.toContainText(/Total wait -/);
    await page.getByText("Evaluation evidence", { exact: true }).click();
    await expect(page.locator(".safety-verdict")).toContainText("Deterministic rules");
    await page.getByRole("button", { name: "Show assessed context" }).click();
    await expect(page.locator(".safety-verdict pre").last()).toContainText("Safety browser fixture");
    await page.screenshot({ path: "../data/qa/safety-explorer.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "../data/qa/safety-mobile.png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  } finally {
    await request.patch(`/api/connections/${connection.id}/hooks`, { data: { enabled: false } });
    await request.delete(`/api/connections/${connection.id}`);
  }
});
