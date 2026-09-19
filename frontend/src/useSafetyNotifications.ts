import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SafetyEvaluation } from "./api";

const preference = "relay-review-notifications";
export function useSafetyNotifications() {
  const supported = "Notification" in window && "serviceWorker" in navigator && window.isSecureContext;
  const [enabled, setEnabled] = useState(() => localStorage.getItem(preference) === "on");
  const [error, setError] = useState("");
  const client = useQueryClient();
  const pending = useQuery({ queryKey: ["notification-reviews"], queryFn: async () => {
    const items: { title: string; tool_name: string; evaluation: SafetyEvaluation }[] = [];
    let offset = 0, total = 1;
    while (offset < total) {
      const page = await api<{ total: number; items: typeof items }>(`/safety/actions?safety_state=awaiting_review&limit=100&offset=${offset}`);
      items.push(...page.items); total = page.total; offset += 100;
    }
    return items;
  }, refetchInterval: 2000, refetchIntervalInBackground: true });
  useEffect(() => {
    if (!supported) return;
    const changed = () => setEnabled(localStorage.getItem(preference) === "on");
    const message = (event: MessageEvent) => {
      if (event.data?.type === "review-updated") void client.invalidateQueries();
    };
    window.addEventListener("storage", changed);
    navigator.serviceWorker.addEventListener("message", message);
    return () => { window.removeEventListener("storage", changed); navigator.serviceWorker.removeEventListener("message", message); };
  }, [supported, client]);
  useEffect(() => {
    if (!supported || !enabled || Notification.permission !== "granted" || !pending.data) return;
    navigator.serviceWorker.register("/review-notifications.js").then(() => navigator.serviceWorker.ready).then(registration => {
      registration.active?.postMessage({ type: "reviews", items: pending.data });
    }).catch(() => setError("Notifications could not start. Try enabling them again."));
  }, [supported, enabled, pending.data]);
  async function toggle() {
    setError("");
    if (enabled) {
      localStorage.removeItem(preference); setEnabled(false);
      const registration = await navigator.serviceWorker.getRegistration();
      (await registration?.getNotifications() ?? []).forEach(n => n.close());
      return;
    }
    try {
      if (!supported) throw new Error("This browser does not support desktop notifications.");
      if (await Notification.requestPermission() !== "granted") throw new Error("Allow notifications in your browser's site settings, then try again.");
      await navigator.serviceWorker.register("/review-notifications.js");
      localStorage.setItem(preference, "on"); setEnabled(true);
    } catch (err) { setError((err as Error).message); }
  }
  return { enabled: enabled && supported && Notification.permission === "granted", supported, error, toggle, items: pending.data ?? [], count: pending.data?.length ?? 0 };
}
export type SafetyNotifications = ReturnType<typeof useSafetyNotifications>;
