import { test, expect } from "@playwright/test";
import path from "node:path";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { python } from "./python";

test("live observer setup, receipt, transcript correlation and disable", async ({ page, request }) => {
  const root = path.resolve("../data/e2e-hook-profile/sessions");
  await mkdir(root, { recursive: true });
  const transcript = path.join(root, "rollout-live.jsonl");
  await writeFile(transcript, JSON.stringify({ type: "session_meta", timestamp: new Date().toISOString(), payload: { id: "live-session", originator: "codex-tui", source: "cli" } }) + "\n");
  const connection = await (await request.post("/api/connections", { data: { name: "Live observation test", provider: "codex_cli", path: root } })).json();
  await page.goto("/");
  await page.getByRole("button", { name: /Connections/ }).click();
  const card = page.locator(".connection-card").filter({ hasText: "Live observation test" });
  await card.getByRole("button", { name: "Set up live hooks" }).click();
  await expect(page.getByRole("dialog")).toContainText("Relay returns no permission decisions");
  await page.getByRole("button", { name: "Enable live hooks", exact: true }).click();
  await expect(card).toContainText("Waiting for first hook");
  async function deliver(phase: string) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(python, [path.resolve("../scripts/observe_hook.py"), path.resolve(`../data/hook-queue/${connection.id}`)], { stdio: ["pipe", "pipe", "pipe"] });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Observer exited ${code}`)));
      child.stdin.end(JSON.stringify({ session_id: "live-session", transcript_path: transcript, hook_event_name: phase, tool_use_id: "live-call", tool_name: "Bash", tool_input: { command: "echo relay" }, tool_response: { exit_code: 0 } }));
    });
  }
  await deliver("PreToolUse");
  await expect(card).toContainText("Last received");
  const params = `?connection=${connection.id}`;
  await expect.poll(async () => (await (await request.get(`/api/metrics${params}`)).json()).actions).toBe(1);
  await appendFile(transcript, JSON.stringify({ type: "response_item", timestamp: new Date().toISOString(), payload: { type: "function_call", name: "exec_command", call_id: "live-call", arguments: '{"cmd":"echo relay"}' } }) + "\n");
  await deliver("PostToolUse");
  await request.post(`/api/connections/${connection.id}/sync`);
  const sessions = await (await request.get(`/api/sessions${params}`)).json();
  await expect.poll(async () => (await (await request.get(`/api/sessions/${sessions.items[0].id}/events`)).json()).items[0].hook_state).toBe("completed");
  expect((await (await request.get(`/api/metrics${params}`)).json()).actions).toBe(1);
  await card.getByRole("button", { name: "Manage hooks" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "../data/qa/hooks-mobile.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "Remove hooks" }).click();
  await expect(card).toContainText("Not installed");
  await expect(card.getByRole("button", { name: "Set up live hooks" })).toBeVisible();
  await request.delete(`/api/connections/${connection.id}`);
});
