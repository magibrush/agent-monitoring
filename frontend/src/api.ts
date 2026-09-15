export interface Connection {
  id: string;
  name: string;
  provider: "codex";
  path: string | null;
  enabled: boolean;
  status: string;
  error: string | null;
  last_sync: string | null;
}
export interface Session {
  id: string;
  external_id: string;
  title: string;
  connection_name: string;
  provider: string;
  messages: number;
  actions: number;
  updated_at: string;
  source: string;
}
export interface ChatEvent {
  id: number;
  role: string;
  kind: string;
  text: string;
  tool_name: string | null;
  occurred_at: string;
}
export interface Metrics {
  sessions: number;
  messages: number;
  questions: number;
  answers: number;
  actions: number;
  daily: { day: string; role: string; kind: string; count: number }[];
  tools: { name: string; count: number }[];
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch("/api" + path, init);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(
      typeof data?.detail === "string"
        ? data.detail
        : `Request failed (${res.status}). Check your input and backend.`,
    );
  }
  return res.json();
}
export const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
