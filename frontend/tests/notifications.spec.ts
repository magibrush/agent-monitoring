import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("notification deduplication, decisions, expiry and window routing", async () => {
  const handlers: Record<string, (event: any) => void> = {};
  const saved = new Map<string, Response>();
  const shown: any[] = [], requests: any[] = [], messages: any[] = [], opened: string[] = [];
  let windows: any[] = [], focused = 0, failure = false;
  const self = {
    location: { origin: "http://localhost:8000" },
    addEventListener: (name: string, handler: any) => handlers[name] = handler,
    registration: { getNotifications: async () => [], showNotification: async (title: string, options: any) => shown.push({ title, ...options }) },
    clients: { matchAll: async () => windows, openWindow: async (url: string) => opened.push(url) },
  };
  runInNewContext(readFileSync("public/review-notifications.js", "utf8"), {
    self, URL, Response, Date, Set, Promise, encodeURIComponent,
    caches: { open: async () => ({ keys: async () => [...saved.keys()], match: async (key: string) => saved.get(key)?.clone(), put: async (key: string, value: Response) => saved.set(key, value), delete: async (key: string) => saved.delete(key) }) },
    fetch: async (url: string, init: any) => { requests.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ detail: "Already decided" }), { status: failure ? 409 : 200 }); },
  });
  async function dispatch(type: string, body: any) {
    let done: Promise<unknown> = Promise.resolve();
    handlers[type]({ ...body, waitUntil: (promise: Promise<unknown>) => done = promise }); await done;
  }
  const item = { title: "Synthetic session", tool_name: "Bash", evaluation: { id: "review-one", input_hash: "hash", deadline: new Date(Date.now() + 60000).toISOString() } };
  await dispatch("message", { data: { type: "reviews", items: [item] } });
  await dispatch("message", { data: { type: "reviews", items: [item] } });
  expect(shown).toHaveLength(1);
  expect(shown[0].body).toContain("Expires");
  expect(shown[0].actions.map((a: any) => a.action)).toEqual(["approve", "deny"]);
  const notification = { data: shown[0].data, close() {} };
  await dispatch("notificationclick", { notification, action: "approve" });
  expect(requests[0].body).toEqual({ decision: "approve", input_hash: "hash" });
  await dispatch("notificationclick", { notification, action: "deny" });
  expect(requests[1].body.decision).toBe("deny");
  await dispatch("notificationclick", { notification, action: "" });
  expect(opened[0]).toContain("/#safety?review=review-one");
  windows = [{ url: "http://localhost:8000/", postMessage: (data: any) => messages.push(data), focus: async () => focused++ }];
  await dispatch("notificationclick", { notification, action: "" });
  expect(focused).toBe(1); expect(messages[0].type).toBe("open-review");
  failure = true;
  await dispatch("notificationclick", { notification, action: "approve" });
  expect(messages.at(-1).hash).toContain("Already%20decided");
  notification.data.deadline = new Date(Date.now() - 1000).toISOString();
  const count = requests.length;
  await dispatch("notificationclick", { notification, action: "approve" });
  expect(requests).toHaveLength(count);
  expect(messages.at(-1).hash).toContain("expired");
});

test("notification link opens Safety and permission is only requested by a click", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).permissionRequests = 0;
    Notification.requestPermission = async () => { (window as any).permissionRequests++; return "denied"; };
  });
  await page.goto("/#safety?review=missing");
  await expect(page.getByRole("heading", { name: "Safety", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).permissionRequests)).toBe(0);
  await page.getByRole("button", { name: "Enable notifications", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("site settings");
  expect(await page.evaluate(() => (window as any).permissionRequests)).toBe(1);
});
