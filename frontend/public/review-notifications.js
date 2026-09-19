/* Persistent notifications; the open Relay page supplies the live queue. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
let queue = Promise.resolve();
async function syncReviews(items) {
  const cache = await caches.open("relay-review-alerts-v1");
  const active = items.filter(item => Date.parse(item.evaluation.deadline) > Date.now());
  const ids = new Set(active.map(item => item.evaluation.id));
  for (const notification of await self.registration.getNotifications()) {
    if (!ids.has(notification.data?.id)) notification.close();
  }
  for (const key of await cache.keys()) {
    const saved = await cache.match(key);
    if (Number(await saved.text()) < Date.now() - 86400000) await cache.delete(key);
  }
  for (const item of active) {
    const e = item.evaluation;
    const key = new URL(`/__review_alert/${encodeURIComponent(e.id)}`, self.location.origin).href;
    if (await cache.match(key)) continue;
    await self.registration.showNotification(`${item.tool_name} needs your approval`, {
      body: `Expires ${new Date(e.deadline).toLocaleTimeString()} - ${item.title}\n${e.result?.reason || "Review this action before its deadline."}`,
      tag: `relay-review-${e.id}`, requireInteraction: true,
      data: { id: e.id, input_hash: e.input_hash, deadline: e.deadline },
      actions: [{ action: "approve", title: "Approve" }, { action: "deny", title: "Deny" }],
    });
    await cache.put(key, new Response(String(Date.parse(e.deadline))));
  }
}
self.addEventListener("message", event => {
  if (event.data?.type !== "reviews") return;
  queue = queue.catch(() => {}).then(() => syncReviews(event.data.items));
  event.waitUntil(queue);
});
async function openReview(id, message = "") {
  const url = new URL(`/#safety?review=${encodeURIComponent(id)}&message=${encodeURIComponent(message)}`, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
  if (existing) {
    existing.postMessage({ type: "open-review", hash: new URL(url).hash });
    await existing.focus();
  } else await self.clients.openWindow(url);
}
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data;
    if (!["approve", "deny"].includes(event.action)) return openReview(data.id);
    try {
      if (Date.parse(data.deadline) <= Date.now()) throw new Error("This request has expired.");
      const response = await fetch(`/api/safety/evaluations/${encodeURIComponent(data.id)}/review`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: event.action, input_hash: data.input_hash }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.detail === "string" ? body.detail : "The decision could not be saved. Review the request in Relay.");
      }
      for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage({ type: "review-updated" });
    } catch (error) { await openReview(data.id, error.message); }
  })());
});
