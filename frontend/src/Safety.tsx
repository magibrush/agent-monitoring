import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { api, json, type SafetyEvaluation } from "./api";

export function SafetyStatus() {
  const status = useQuery({ queryKey: ["safety"], queryFn: () => api<{
    model: string; key_configured: boolean; key_file: string; counts: Record<string, number>;
    workers: { id: string; status: string }[]; oldest_pending_at: string | null;
  }>("/safety"), refetchInterval: 2000 });
  const data = status.data;
  return <section className="panel safety-panel" aria-label="Safety evaluation status">
    <div className="safety-heading"><ShieldCheck size={20} /><h2>Judge & worker health</h2><span className="badge">Haiku + rules</span></div>
    {status.error && <p className="error" role="alert">{status.error.message}</p>}
    {data && <>
      <div className="safety-counts"><strong>{!data.key_configured ? "Waiting for Anthropic key" : !data.workers.length ? "Worker offline" : "Worker running"}</strong>
        <span>{data.counts.queued ?? 0} queued</span><span>{data.counts.running ?? 0} evaluating</span><strong>{data.counts.awaiting_review ?? 0} awaiting approval</strong><span>{data.counts.completed ?? 0} completed</span><span>{(data.counts.failed ?? 0) + (data.counts.skipped ?? 0)} failed / expired</span></div>
      {data.oldest_pending_at && <p className="safety-muted">Oldest queued: {new Date(data.oldest_pending_at).toLocaleString()}</p>}
      <p className="safety-muted">Workspace-wide job counts, independent of the filters above.</p>
      <details><summary>Judge settings and data sharing</summary><p>Model: <code>{data.model}</code>. Put your API key alone in this local file:</p><code className="safety-path">{data.key_file}</code>
        <p>The worker reads the file automatically. Action arguments, bounded recent transcript context and up to three user requests are sent to Anthropic after limited secret redaction. Redaction is not comprehensive. Existing transcript history is not backfilled for evaluation.</p>
        <p>Start Relay with <code>scripts/start.ps1</code>, or run <code>scripts/start-worker.ps1</code> beside an existing server. Inspect individual verdicts in Explorer.</p>
      </details>
    </>}
  </section>;
}

export function SafetyVerdict({ evaluation: e }: { evaluation: SafetyEvaluation }) {
  const client = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const [showSnapshot, setShowSnapshot] = useState(false);
  const snapshot = useQuery({ queryKey: ["evaluation", e.id], queryFn: () => api<{ snapshot: unknown; attempt_history: { id: string; number: number; error: string | null; started_at: string }[] }>(`/safety/evaluations/${e.id}`), enabled: showSnapshot });
  const decision = e.result?.recommendation;
  const blocking = e.mode === "blocking";
  const label = blocking ? e.gate?.decision === "pass" && e.returned_at ? "Released to provider permissions" : e.decision === "expired" ? "Expired · action blocked" : e.decision === "error" || e.status === "failed" ? "Blocked · evaluation failed" : e.decision === "deny" ? e.human_decision === "deny" ? "Denied by you" : decision === "review" ? "Review requested · blocked by previous policy" : "Denied" : e.decision === "pass" ? "Decision ready · awaiting hook" : e.status === "awaiting_review" ? "Awaiting your approval · action paused" : "Waiting for evaluation" : e.result ? `Shadow · ${decision === "allow" ? "Would allow" : decision === "deny" ? "Would deny" : "Needs review"}` : `Shadow · ${e.status === "failed" || e.status === "skipped" ? "Not evaluated" : e.status === "running" ? "Evaluating" : "Queued"}`;
  async function retry() {
    setRetrying(true); setRetryError("");
    try { await api(`/safety/evaluations/${e.id}/retry`, { method: "POST" }); await client.invalidateQueries(); }
    catch (error) { setRetryError((error as Error).message); }
    finally { setRetrying(false); }
  }
  return <div className={`safety-verdict ${decision === "deny" || e.gate?.decision === "deny" ? "safety-danger" : ""}`}>
    <strong>{label}</strong>
    <span className="safety-muted">{e.gate ? ` · Gate returned ${e.gate.decision}` : " · No gate decision recorded"}</span>
    {e.result && <p>{e.result.reason}</p>}
    {e.result && <p className="safety-muted">Risk: {e.result.risk} · Recommendation: {e.result.recommendation}</p>}
    {e.human_decision && <p>Human decision: {e.human_decision === "approve" ? "Approved" : "Denied"} at {new Date(e.reviewed_at!).toLocaleString()}. Judge recommendation is preserved.</p>}
    {e.status === "awaiting_review" && <HumanReviewControls evaluation={e} />}
    {e.decision === "expired" && <p>The waiting hook can no longer be approved. Submit a new tool request for a fresh evaluation.</p>}
    {e.error && <p className="error">{e.error}</p>}
    <ol className="safety-lifecycle" aria-label="Action evaluation timeline">{[["Requested", e.created_at], ["Evaluating", e.started_at], ["Decision", e.decision_at || e.completed_at], ["Hook returned", e.returned_at]].map(([label, at]) => <li key={label} className={at ? "reached" : ""}><strong>{label}</strong><span>{at ? new Date(at).toLocaleTimeString() : "—"}</span></li>)}</ol>
    {e.deadline && <p className="safety-muted">Deadline {new Date(e.deadline).toLocaleTimeString()}{e.returned_at ? ` · Total wait ${((Date.parse(e.returned_at) - Date.parse(e.created_at)) / 1000).toFixed(1)} s` : " · Late results cannot release this request"}</p>}
    {(e.status === "failed" || e.status === "skipped") && <><button className="secondary" disabled={retrying} onClick={retry}>{retrying ? "Queuing review…" : "Review again in shadow mode"}</button><p className="safety-muted">A new review preserves this failure and never resumes the original action.</p></>}
    {retryError && <p className="error">{retryError}</p>}
    <details><summary>Evaluation evidence</summary>
      <p>{e.result?.source === "rules" ? "Deterministic rules" : e.model} · Policy {e.policy_version} · {e.attempts} attempt(s){e.latency_ms != null ? ` · ${e.latency_ms} ms` : ""}</p>
      {e.rules.findings.map((f, i) => <p key={i}><code>{f.id}</code>: {f.reason}</p>)}
      {e.result?.evidence.map((s, i) => <p key={`e${i}`}>{s}</p>)}
      {!!e.result?.missing_context.length && <p>Missing context: {e.result.missing_context.join("; ")}</p>}
      {e.usage && <p>{e.usage.input_tokens ?? 0} input / {e.usage.output_tokens ?? 0} output tokens</p>}
      {e.diagnostics != null && <pre className="hook-config">{JSON.stringify(e.diagnostics, null, 2)}</pre>}
      <button className="secondary" onClick={() => setShowSnapshot(!showSnapshot)}>{showSnapshot ? "Hide assessed context" : "Show assessed context"}</button>
      {showSnapshot && (snapshot.error ? <p className="error">{snapshot.error.message}</p> : <pre className="hook-config">{snapshot.data ? JSON.stringify(snapshot.data.snapshot, null, 2) : "Loading…"}</pre>)}
      {showSnapshot && snapshot.data?.attempt_history.map(a => <p key={a.id}>Attempt {a.number} · {new Date(a.started_at).toLocaleTimeString()} · {a.error || "Completed / in progress"}</p>)}
    </details>
  </div>;
}

export const SAFETY_SERIES = [
  { key: "pending", label: "Pending", color: "#b7791f" },
  { key: "awaiting_review", label: "Awaiting approval", color: "#ce751d" },
  { key: "released", label: "Released", color: "#218575" },
  { key: "denied", label: "Denied", color: "#ba4242" },
  { key: "error", label: "Evaluation failed", color: "#935ac5" },
  { key: "shadow", label: "Shadow assessed", color: "#557daf" },
  { key: "unassessed", label: "Not assessed", color: "#a9b3c0" },
];

function HumanReviewControls({ evaluation: e }: { evaluation: SafetyEvaluation }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [time, setTime] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setTime(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const details = useQuery({ queryKey: ["review-action", e.id], queryFn: () => api<{ snapshot: { action: string; action_truncated: boolean } }>(`/safety/evaluations/${e.id}`) });
  const remaining = Math.max(0, Math.ceil((Date.parse(e.deadline || "") - time) / 1000));
  async function decide(decision: "approve" | "deny") {
    setBusy(true); setError("");
    try { await api(`/safety/evaluations/${e.id}/review`, json("POST", { decision, input_hash: e.input_hash })); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); await client.invalidateQueries(); }
  }
  return <section className="human-review-controls" aria-label="Human approval">
    <strong>{remaining > 0 ? `${remaining}s remaining to decide` : "Approval window expired"}</strong>
    <p>Approval applies to this tool request.</p>
    {details.data && <><p className="safety-muted">Assessed action (secrets may be redacted):</p><pre className="hook-config">{details.data.snapshot.action}</pre>{details.data.snapshot.action_truncated && <p>Action was truncated. Deny and request a smaller, inspectable action.</p>}</>}
    {details.error && <p className="error">{details.error.message}</p>}
    <div className="safety-counts"><button className="primary" disabled={busy || !remaining || !details.data || details.data.snapshot.action_truncated} onClick={() => decide("approve")}>Approve</button><button className="secondary" disabled={busy || !remaining} onClick={() => decide("deny")}>Deny</button></div>
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}

export function HumanReviewQueue() {
  return <section className="panel human-review-queue"><h2>Needs your decision</h2><p className="safety-muted">Live requests across all connections, independent of page filters. Pending means automated evaluation; awaiting approval means Haiku requested your decision. Requests expire within 60 seconds of the tool call.</p><SafetyInspection params="" initialState="awaiting_review" reviewQueue /></section>;
}

export function SafetyInspection({ params, initialState = "", outcome: selectedOutcome, onOutcomeChange, reviewQueue = false }: { params: string; initialState?: string; outcome?: string; onOutcomeChange?: (value: string) => void; reviewQueue?: boolean }) {
  const [localOutcome, setLocalOutcome] = useState(initialState);
  const outcome = selectedOutcome ?? localOutcome;
  function setOutcome(value: string) { setLocalOutcome(value); onOutcomeChange?.(value); }
  const [flagged, setFlagged] = useState(false);
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [params, outcome]);
  const query = new URLSearchParams(params);
  query.set("safety_state", outcome); query.set("flagged_only", String(flagged)); query.set("offset", String(offset));
  const result = useQuery({ queryKey: ["safety-actions", query.toString()], queryFn: () => api<{ total: number; items: { event_id: number; tool_name: string; title: string; safety_state: string; occurred_at: string; execution_outcome: string | null; flagged: boolean; evaluation: SafetyEvaluation | null }[] }>(`/safety/actions?${query}`) });
  return <section className="safety-inspection" aria-label={reviewQueue ? "Awaiting human decisions" : "Safety actions"}>
    {!reviewQueue && <><h3>Action review</h3><label>Outcome <select aria-label="Filter safety outcome" value={outcome} onChange={e => { setOutcome(e.target.value); setOffset(0); }}><option value="">All outcomes</option>{SAFETY_SERIES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
    <label><input type="checkbox" checked={flagged} onChange={e => { setFlagged(e.target.checked); setOffset(0); }} />Flagged risk only</label></>}
    {result.error && <p className="error">{result.error.message}</p>}
    <p aria-live="polite">{result.isPending ? "Loading actions…" : `${result.data?.total ?? 0} actions in this scope`}</p>
    {result.data?.total === 0 && <p className="safety-muted">No actions match these filters. Try another outcome or widen the time range.</p>}
    {result.data?.items.map(item => <details key={item.event_id} open={reviewQueue ? true : undefined}><summary><span className="safety-action-title">{item.tool_name} · {item.title}</span><span className="safety-outcome-badge" style={{ borderColor: SAFETY_SERIES.find(s => s.key === item.safety_state)?.color }}>{SAFETY_SERIES.find(s => s.key === item.safety_state)?.label ?? item.safety_state}</span>{item.flagged && <span className="safety-risk-badge">Flagged</span>}<time>{new Date(item.occurred_at).toLocaleTimeString()}</time></summary><p>{new Date(item.occurred_at).toLocaleString()} · Execution outcome: {item.execution_outcome || "Unknown"}</p>{item.evaluation ? <SafetyVerdict evaluation={item.evaluation} /> : <p>No evaluation recorded. Hook coverage is not confirmed for this action.</p>}</details>)}
    <div className="safety-counts"><button className="secondary" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous actions</button><button className="secondary" disabled={offset + 20 >= (result.data?.total ?? 0)} onClick={() => setOffset(offset + 20)}>Next actions</button></div>
  </section>;
}
