import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, Clock3, Settings2, ShieldCheck, X } from "lucide-react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, json, type Connection, type Metrics, type SafetyEvaluation } from "./api";
import { SAFETY_SERIES } from "./Safety";
import { HookSetup, Modal } from "./ui";
import { FIT, TimeRange, type Range } from "./TimeRange";

type Action = { event_id: number; title: string; tool_name: string; occurred_at: string; safety_state: string; execution_outcome: string | null; evaluation: SafetyEvaluation | null };
type Actions = { total: number; items: Action[] };
type Assessment = { snapshot: { action: string; action_truncated: boolean }; attempt_history: unknown[] };
const labels: Record<string, string> = { pending: "Evaluating", awaiting_review: "Awaiting approval", released: "Released", denied: "Denied", error: "Failed / expired", shadow: "Shadow", unassessed: "Not assessed" };
const explanations: Record<string, string> = { pending: "Queued or being evaluated", awaiting_review: "Waiting for a human decision", released: "Released to provider permissions; execution is recorded separately", denied: "Blocked by a judge, rule or human decision", error: "Evaluation failed or the request expired", shadow: "Advisory assessment; did not block execution", unassessed: "No assessment recorded" };
function Outcome({ state }: { state: string }) {
  return <span className="safety-tag" title={explanations[state]}><i style={{ background: SAFETY_SERIES.find(s => s.key === state)?.color }} />{labels[state] ?? state}</span>;
}
function currentOutcome(e: SafetyEvaluation | null, fallback: string) {
  if (!e) return fallback;
  if (e.returned_at && e.gate?.decision === "pass") return "released";
  if (["error", "expired"].includes(e.decision || "") || ["failed", "skipped"].includes(e.status)) return "error";
  if (e.decision === "deny" || e.gate?.decision === "deny") return "denied";
  if (e.status === "awaiting_review") return "awaiting_review";
  if (e.mode === "blocking" || ["queued", "running"].includes(e.status)) return "pending";
  return "shadow";
}
function ActionCode({ action }: { action: string }) {
  let code = action, cwd = "";
  try { const parsed = JSON.parse(action); const input = parsed.tool_input ?? parsed; cwd = parsed.cwd ?? ""; code = Object.keys(input).length === 1 && typeof Object.values(input)[0] === "string" ? String(Object.values(input)[0]) : JSON.stringify(input, null, 2); } catch { /* Preserve assessed input verbatim. */ }
  return <><pre className="decision-command">{code}</pre>{cwd && <small className="decision-cwd">{cwd}</small>}</>;
}
function Reason({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return <div className="decision-reason"><p className={expanded ? "" : "clamped"}>{text}</p>{text.length > 180 && <button className="text-button" onClick={() => setExpanded(!expanded)}>{expanded ? "Less" : "Full reason"}</button>}</div>;
}
function ApprovalCard({ item }: { item: Action }) {
  const e = item.evaluation!, client = useQueryClient();
  const [time, setTime] = useState(Date.now()), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const detail = useQuery({ queryKey: ["review-action", e.id], queryFn: () => api<Assessment>(`/safety/evaluations/${e.id}`) });
  useEffect(() => { const id = setInterval(() => setTime(Date.now()), 1000); return () => clearInterval(id); }, []);
  const remaining = Math.max(0, Math.ceil((Date.parse(e.deadline || "") - time) / 1000));
  async function decide(decision: "approve" | "deny") {
    setBusy(true); setError("");
    try { await api(`/safety/evaluations/${e.id}/review`, json("POST", { decision, input_hash: e.input_hash })); }
    catch (err) { setError((err as Error).message); }
    finally { await client.invalidateQueries(); setBusy(false); }
  }
  return <article className="decision-card" aria-label={`Review ${item.tool_name}`}>
    <div className="decision-heading"><strong>{item.tool_name}</strong><span className={`decision-clock ${remaining <= 15 ? "urgent" : ""}`}><Clock3 size={14} />{remaining ? `${remaining}s left` : "Expired"}</span></div>
    <p className="decision-session" title={item.title}>{item.title}</p>
    {detail.data ? <ActionCode action={detail.data.snapshot.action} /> : <p className="safety-muted">{detail.error ? "Could not load action. Approval unavailable." : "Loading action…"}</p>}
    <Reason text={e.result?.reason || "Human decision requested."} />
    {detail.data?.snapshot.action_truncated && <p className="error">Incomplete action. Deny and request a smaller action.</p>}
    <div className="decision-footer"><small>{remaining ? "This action only · native permissions still apply" : "Action blocked. Submit a new request."}</small><div><button className="secondary" disabled={busy || !remaining} onClick={() => decide("deny")}>Deny</button><button className="primary" disabled={busy || !remaining || !detail.data || detail.data.snapshot.action_truncated} onClick={() => decide("approve")}>Approve</button></div></div>
    {error && <p className="error" role="alert">{error}</p>}
  </article>;
}
function ActionDetail({ item, close }: { item: Action; close: () => void }) {
  const initial = item.evaluation;
  const detail = useQuery({ queryKey: ["evaluation", initial?.id], queryFn: () => api<SafetyEvaluation & Assessment>(`/safety/evaluations/${initial!.id}`), enabled: Boolean(initial) });
  const e = detail.data ?? initial, client = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function reassess() {
    setBusy(true);
    try { await api(`/safety/evaluations/${e!.id}/retry`, { method: "POST" }); await client.invalidateQueries(); setError("Shadow review queued. Original action remains blocked."); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <Modal close={close}><div className="modal-heading"><div><h2 id="dialog-title">{item.tool_name}</h2><p>{item.title}</p></div><button className="icon-button" aria-label="Close action details" onClick={close}><X size={20} /></button></div><div className="safety-detail">
    <Outcome state={currentOutcome(e, item.safety_state)} /><time>{new Date(item.occurred_at).toLocaleString()}</time>
    {detail.data && e?.status !== "awaiting_review" && <ActionCode action={detail.data.snapshot.action} />}
    {detail.error && <p className="error">{detail.error.message}</p>}
    {e ? <>
      {e.status === "awaiting_review" ? <ApprovalCard item={{ ...item, evaluation: e }} /> : <p className="detail-reason">{e.result?.reason || e.error || "Evaluation in progress."}</p>}
      <dl className="decision-facts"><div><dt>{e.result?.source === "rules" ? "Rules" : "Judge"}</dt><dd>{e.result ? ({ allow: "Allow", review: "Review", deny: "Deny" }[e.result.recommendation] ?? e.result.recommendation) : "Not completed"}</dd></div><div><dt>Human decision</dt><dd>{e.human_decision === "approve" ? "Approved" : e.human_decision === "deny" ? "Denied" : "None"}</dd></div><div><dt>Hook returned</dt><dd>{e.gate ? ({ pass: "Released", deny: "Blocked", error: "Failed", expired: "Expired" }[e.gate.decision] ?? "Unknown") : "Not confirmed"}</dd></div><div><dt>Execution</dt><dd>{({ requested: "Not confirmed", succeeded: "Succeeded", failed: "Failed", completed: "Completed" }[item.execution_outcome || ""] ?? "Unknown")}</dd></div></dl>
      {e.decision === "expired" && <p className="error">Expired. Submit a new tool request; this action cannot resume.</p>}
      {e.gate?.decision === "pass" && <p className="safety-muted">Released to provider permissions. This does not confirm successful execution.</p>}
      {e.result?.recommendation === "review" && e.decision === "deny" && !e.human_decision && <p className="safety-muted">Review requested; blocked by the previous policy.</p>}
      <details className="safety-technical"><summary>Technical details</summary><p>{e.result?.source === "rules" ? "Deterministic rules" : e.model} · {e.policy_version} · {e.latency_ms ?? "—"} ms</p>
        <ol className="safety-lifecycle">{[["Requested", e.created_at], ["Judge finished", e.completed_at], ["Gate decision", e.decision_at], ["Hook returned", e.returned_at]].map(([label, at]) => <li key={label} className={at ? "reached" : ""}><strong>{label}</strong><span>{at ? new Date(at).toLocaleTimeString() : "—"}</span></li>)}</ol>
        {e.rules.findings.map((f, i) => <p key={i}>{f.reason}</p>)}{e.result?.evidence.map((text, i) => <p key={i}>{text}</p>)}
        {!!e.result?.missing_context.length && <p>Missing context: {e.result.missing_context.join("; ")}</p>}
        {e.error && <p className="error">{e.error}</p>}{e.reviewed_at && <p>Human decision at {new Date(e.reviewed_at).toLocaleString()}</p>}
        {detail.data && <pre className="hook-config">{JSON.stringify({ context: detail.data.snapshot, attempts: detail.data.attempt_history, diagnostics: e.diagnostics }, null, 2)}</pre>}
        {(e.status === "failed" || e.status === "skipped") && <><button className="secondary" disabled={busy} onClick={reassess}>Review again in shadow mode</button><p className="safety-muted">Sends assessed context to Anthropic again. Cannot resume this action.</p></>}{error && <p role="status">{error}</p>}
      </details>
    </> : <p>No assessment recorded for this action.</p>}
  </div></Modal>;
}
export function SafetyWorkspace({ connections, refresh, notify }: { connections: Connection[]; refresh: () => void; notify: (message: string) => void }) {
  const [settings, setSettings] = useState(false), [configuring, setConfiguring] = useState<Connection | null>(null);
  const [connection, setConnection] = useState(""), [range, setRange] = useState<Range>(FIT), [outcome, setOutcome] = useState(""), [offset, setOffset] = useState(0), [bucket, setBucket] = useState<number | null>(null), [opened, setOpened] = useState<Action | null>(null);
  const status = useQuery({ queryKey: ["safety"], queryFn: () => api<{ model: string; key_configured: boolean; key_file: string; workers: unknown[]; counts: Record<string, number> }>("/safety") });
  const [reviewOffset, setReviewOffset] = useState(0);
  const approvals = useQuery({ queryKey: ["safety-actions", "live", reviewOffset], queryFn: () => api<Actions>(`/safety/actions?safety_state=awaiting_review&offset=${reviewOffset}`) });
  const params = new URLSearchParams({ connection, start: range.start, end: range.end });
  const metrics = useQuery({ queryKey: ["safety-history", params.toString()], queryFn: () => api<Metrics>(`/metrics?${params}`) });
  const scoped = new URLSearchParams(params);
  if (bucket !== null && metrics.data) { scoped.set("start", new Date(bucket).toISOString()); scoped.set("end", new Date(bucket + metrics.data.interval_seconds * 1000).toISOString()); }
  scoped.set("safety_state", outcome); scoped.set("offset", String(offset));
  const actions = useQuery({ queryKey: ["safety-actions", scoped.toString()], queryFn: () => api<Actions>(`/safety/actions?${scoped}`) });
  useEffect(() => { setOffset(0); setBucket(null); }, [connection, range]);
  useEffect(() => setOffset(0), [outcome, bucket]);
  useEffect(() => { if (reviewOffset && approvals.data && reviewOffset >= approvals.data.total) setReviewOffset(0); }, [reviewOffset, approvals.data]);
  const ready = status.data?.key_configured && Boolean(status.data.workers.length);
  const bars = metrics.data?.series.map(row => ({ time: row.time, ...row.safety })) ?? [];
  return <div className="safety-simple">
    <div className="safety-topline" aria-label="Safety evaluation status"><span><ShieldCheck size={17} /><i className={`status-dot ${ready ? "" : "red"}`} />{status.isPending ? "Connecting…" : status.error ? "Status unavailable" : !status.data?.key_configured ? "Waiting for Anthropic key" : !status.data.workers.length ? "Worker offline" : "Judge online"}</span><button className="secondary" onClick={() => setSettings(true)}><Settings2 size={15} />Settings</button></div>
    <section className="live-decisions" aria-label="Awaiting human decisions"><div className="safety-section-title"><h2>Needs your decision {Boolean(approvals.data?.total) && <span className="count">{approvals.data!.total}</span>}</h2><small>Live · all connections</small></div>
      {approvals.error ? <p className="error">{approvals.error.message}</p> : approvals.isPending ? <p className="safety-muted">Loading requests…</p> : approvals.data?.total === 0 ? <div className="decisions-clear"><CheckCircle2 size={19} />No actions waiting for approval</div> : approvals.data?.items.map(item => <ApprovalCard key={item.event_id} item={item} />)}
      {!!approvals.data && approvals.data.total > 20 && <div className="safety-pager"><button disabled={!reviewOffset} onClick={() => setReviewOffset(Math.max(0, reviewOffset - 20))}>Previous</button><button disabled={reviewOffset + 20 >= approvals.data.total} onClick={() => setReviewOffset(reviewOffset + 20)}>Next</button></div>}
    </section>
    <section className="panel safety-history" aria-label="Action history"><div className="safety-history-heading"><h2>Action history</h2><div><select aria-label="Filter connection" value={connection} onChange={e => setConnection(e.target.value)}><option value="">All connections</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><TimeRange value={range} onChange={setRange} /></div></div>
      <div className="outcome-filters" aria-label="Safety outcomes in selected scope"><button aria-pressed={!outcome} onClick={() => setOutcome("")}>All <b>{metrics.data?.actions ?? 0}</b></button>{SAFETY_SERIES.map(s => <button key={s.key} aria-pressed={outcome === s.key} title={explanations[s.key]} onClick={() => setOutcome(outcome === s.key ? "" : s.key)}><i style={{ background: s.color }} />{labels[s.key]} <b>{metrics.data?.safety?.[s.key] ?? 0}</b></button>)}</div>
      {metrics.error && <p className="error">{metrics.error.message}</p>}
      {!!metrics.data?.actions && <div className="safety-history-chart" aria-label="Action outcomes over time"><ResponsiveContainer width="100%" height={150}><BarChart data={bars} onClick={state => { const time = state?.activeLabel; if (time !== undefined) setBucket(Number(time)); }}><XAxis dataKey="time" tickFormatter={value => new Date(value).toLocaleString(undefined, metrics.data && Date.parse(metrics.data.domain.end) - Date.parse(metrics.data.domain.start) <= 172800000 ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" })} minTickGap={60} tickLine={false} axisLine={false} /><YAxis allowDecimals={false} domain={[0, Math.max(1, ...(metrics.data?.series.map(row => row.actions) ?? []))]} width={28} tickLine={false} axisLine={false} /><Tooltip labelFormatter={value => new Date(Number(value)).toLocaleString()} />{SAFETY_SERIES.map(s => <Bar key={s.key} dataKey={s.key} name={labels[s.key]} stackId="outcome" fill={s.color} maxBarSize={22} isAnimationActive={false}>{bars.map(row => <Cell key={row.time} opacity={bucket === null || bucket === row.time ? 1 : 0.25} />)}</Bar>)}</BarChart></ResponsiveContainer></div>}
      {bucket !== null && <div className="history-scope">{new Date(bucket).toLocaleString()}<button className="text-button" onClick={() => setBucket(null)}>Clear interval <X size={12} /></button></div>}
      <div className="safety-action-list" aria-label="Safety actions">{actions.error ? <p className="error">{actions.error.message}</p> : actions.isPending ? <p>Loading actions…</p> : actions.data?.total === 0 ? <p className="history-empty">No actions in this selection</p> : actions.data?.items.map(item => <button className="safety-action-row" key={item.event_id} onClick={() => setOpened(item)}><div><span className="action-row-identity"><strong>{item.tool_name}</strong><span>{item.title}</span></span><span className="action-row-reason">{item.evaluation?.result?.reason || item.evaluation?.error || "No assessment available"}</span></div><Outcome state={item.safety_state} /><time>{new Date(item.occurred_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><ChevronRight size={16} /></button>)}</div>
      {!!actions.data?.total && <div className="safety-pager"><small>{offset + 1}–{Math.min(offset + 20, actions.data.total)} of {actions.data.total} actions</small>{actions.data.total > 20 && <><button className="secondary" disabled={!offset} onClick={() => setOffset(offset - 20)}>Previous</button><button className="secondary" disabled={offset + 20 >= actions.data.total} onClick={() => setOffset(offset + 20)}>Next</button></>}</div>}
    </section>
    {settings && <Modal close={() => setSettings(false)}><div className="modal-heading"><h2 id="dialog-title">Safety settings</h2><button className="icon-button" aria-label="Close safety settings" onClick={() => setSettings(false)}><X size={20} /></button></div><div className="safety-settings-body"><h3>Protection by connection</h3><p className="safety-muted">Configured modes. Restart sessions after changes; hook coverage may vary.</p>{connections.length === 0 && <p>Add a connection to configure protection.</p>}{connections.map(c => <div className="safety-setting-row" key={c.id}><div><strong>{c.name}</strong><small>{!c.hooks_enabled ? "Hooks not installed" : c.gate_enabled ? "Blocking configured" : "Shadow configured"}</small></div><button className="secondary" aria-label={`Configure protection for ${c.name}`} onClick={() => { setSettings(false); setConfiguring(c); }}>Configure</button></div>)}<h3>Judge</h3><p>{status.data?.model ?? "Loading…"}</p><p className="safety-muted">API key file</p><code className="safety-path">{status.data?.key_file}</code><p className="safety-muted">The worker reads this file automatically. Start it with scripts/start-worker.ps1.</p><h3>Data sharing</h3><p>Action arguments and bounded conversation context are sent to Anthropic. Secret redaction is limited.</p><p className="safety-muted">Blocking requests expire after 60 seconds, including human review. Shadow mode records assessments without stopping actions.</p></div></Modal>}
    {configuring && <HookSetup connection={configuring} close={() => { setConfiguring(null); setSettings(true); }} done={() => { setConfiguring(null); setSettings(true); refresh(); notify("Protection saved. Restart provider sessions and review Codex hooks in /hooks."); }} />}
    {opened && <ActionDetail item={opened} close={() => setOpened(null)} />}
  </div>;
}
