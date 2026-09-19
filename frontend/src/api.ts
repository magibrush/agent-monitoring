export interface Connection {
  id: string;
  name: string;
  provider: string;
  path: string | null;
  enabled: boolean;
  status: string;
  error: string | null;
  last_sync: string | null;
  session_count?: number;
  hooks_enabled: boolean;
  gate_enabled: boolean;
  hook_last_seen: string | null;
  hook_error: string | null;
}
export interface ProviderConfig {
  id: string;
  label: string;
  default_path: string;
  available: boolean;
  source: string;
}
export const providerLabel = (id: string) =>
  ({ codex: "Codex Desktop", codex_cli: "Codex CLI", claude_code: "Claude Code" })[id] ?? id;
export interface Session {
  id: string;
  external_id: string;
  title: string;
  connection_name: string;
  provider: string;
  messages: number;
  actions: number;
  input_tokens?: number | null;
  output_tokens?: number | null;
  tokens_partial?: boolean;
  updated_at: string;
  source: string;
  session_type: string;
  match: { kind: string; text: string; event_id: number | null } | null;
}
export interface ChatEvent {
  evaluations?: SafetyEvaluation[];
  transcript_seen: boolean;
  hook_state: string | null;
  hook_seen_at: string | null;
  id: number;
  role: string;
  kind: string;
  text: string;
  tool_name: string | null;
  occurred_at: string;
  action_category: string;
}
export interface SafetyEvaluation {
  human_decision: "approve" | "deny" | null;
  reviewed_at: string | null;
  mode: "shadow" | "blocking";
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  decision: string | null;
  decision_at: string | null;
  deadline: string | null;
  returned_at: string | null;
  diagnostics: unknown;
  id: string;
  status: string;
  model: string;
  policy_version: string;
  input_hash: string;
  attempts: number;
  latency_ms: number | null;
  error: string | null;
  rules: { policy?: { version: number; reason: string; decision: string }; trial?: { version: number; reason: string; decision: string }; decision: string; findings: { id: string; reason: string }[] };
  gate: { decision: string; policy_version: string } | null;
  result: { recommendation: string; risk: string; reason: string; evidence: string[]; missing_context: string[]; source: string } | null;
  usage: { input_tokens?: number; output_tokens?: number } | null;
}
export interface Metrics {
  safety?: Record<string, number>;
  conversation_series?: { id: string; title: string; provider: string; connection_name: string }[];
  sessions: number;
  messages: number;
  questions: number;
  answers: number;
  actions: number;
  series: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    tokens_partial?: boolean;
    sessions: number;
    safety?: Record<string, number>;
    time: number;
    user: number;
    assistant: number;
    actions: number;
    tools: { name: string; count: number }[];
    conversations?: { id: string; actions: number; messages: number }[];
  }[];
  interval_seconds: number;
  interval_label: string;
  interval_adjusted: boolean;
  window_limited: boolean;
  domain: { start: string; end: string };
  viewport: { start: string; end: string };
  tools: { name: string; count: number }[];
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch("/api" + path, init);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(
      typeof data?.detail === "string"
        ? data.detail
        : Array.isArray(data?.detail) ? data.detail.slice(0, 4).map((item: { msg?: string }) => item.msg || "Invalid input").join("; ") : `Request failed (${res.status}). Check your input and backend.`,
    );
  }
  return res.json();
}
export const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
