import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, CheckCircle2, ChevronRight, Clock3, Search, Settings2, ShieldCheck, X } from "lucide-react";
import { Bar, ComposedChart, Cell, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, json, type Connection, type SafetyEvaluation } from "./api";
import { SafetySettings, type SafetyStatus } from "./SafetySettings";
import { SafetyPolicies } from "./SafetyPolicies";
import { Incidents, Severity } from "./Incidents";
import { SAFETY_SERIES } from "./Safety";
import { HookSetup } from "./ui";
import { useTimeChart, TimeChartControls, TimeChartCaption } from "./TimeChart";
import { RangeNavigator } from "./RangeNavigator";
import { ChartTooltip } from "./ChartTooltip";
import { SeriesTooltipRow } from "./chartSeries";
import type { SafetyNotifications } from "./useSafetyNotifications";
import { FIT, TimeRange, rangeQuery, type Range } from "./TimeRange";
import { DecisionStatus } from "./DecisionStatus";

export type Action = { event_id: number; title: string; tool_name: string; occurred_at: string; safety_state: string; execution_outcome: string | null; evaluation: SafetyEvaluation | null };
type Actions = { total: number; items: Action[] };
type Assessment = { snapshot: { action: string; action_truncated: boolean }; attempt_history: unknown[]; timings?: Record<string, number | null> };
const labels: Record<string, string> = { pending: "Evaluating", awaiting_review: "Awaiting approval", released: "Released", denied: "Denied", error: "Failed / expired", shadow: "Shadow", unassessed: "Not assessed" };
const explanations: Record<string, string> = { pending: "Queued or being evaluated", awaiting_review: "Waiting for a human decision", released: "Released to provider permissions; execution is recorded separately", denied: "Blocked by a judge, rule or human decision", error: "Evaluation failed or the request expired", shadow: "Advisory assessment; did not block execution", unassessed: "No assessment recorded" };
function Outcome({ state }: { state: string }) {
  return <span className="safety-tag" title={explanations[state]}><i style={{ background: SAFETY_SERIES.find(s => s.key === state)?.color }} />{labels[state] ?? state}</span>;
}
export function currentOutcome(e: SafetyEvaluation | null, fallback: string) {
  if (!e) return fallback;
  if (e.returned_at && e.gate?.decision === "pass") return "released";
  if (["error", "expired"].includes(e.decision || "") || ["failed", "skipped"].includes(e.status)) return "error";
  if (e.decision === "deny" || e.gate?.decision === "deny") return "denied";
  if (e.status === "awaiting_review") return "awaiting_review";
  if (e.mode === "blocking" || ["queued", "running"].includes(e.status)) return "pending";
  return "shadow";
}
function ActionSeverity({ evaluation }: { evaluation: SafetyEvaluation | null }) {
  const result = evaluation?.result;
  if (!result) return null;
  return <Severity level={result.recommendation === "review" && result.severity !== "critical" ? "high" : result.severity || result.risk || "medium"} />;
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
  return <article id={`review-${e.id}`} tabIndex={-1} className="decision-card" aria-label={`Review ${item.tool_name}`}>
    <div className="decision-heading"><strong>{item.tool_name} {e.result?.source === "debug" && <small className="debug-badge">Debug</small>}</strong><span className={`decision-clock ${remaining <= 15 ? "urgent" : ""}`}><Clock3 size={14} />{remaining ? `${remaining}s left` : "Expired"}</span></div>
    <div className="incident-row-flags"><Severity level={e.result?.severity === "critical" ? "critical" : "high"} />{e.result?.suspicious && <span className="incident-suspicion">Suspicious</span>}</div><p className="decision-session" title={item.title}>{item.title}</p>
    {detail.data ? <ActionCode action={detail.data.snapshot.action} /> : <p className="safety-muted">{detail.error ? "Could not load action. Approval unavailable." : "Loading action…"}</p>}
    <Reason text={e.result?.reason || "Human decision requested."} />
    {detail.data?.snapshot.action_truncated && <p className="error">Incomplete action. Deny and request a smaller action.</p>}
    <div className="decision-footer"><small>{remaining ? "This action only · native permissions still apply" : "Action blocked. Submit a new request."}</small><div><button className="secondary" disabled={busy || !remaining} onClick={() => decide("deny")}>Deny</button><button className="primary" disabled={busy || !remaining || !detail.data || detail.data.snapshot.action_truncated} onClick={() => decide("approve")}>Approve</button></div></div>
    {error && <p className="error" role="alert">{error}</p>}
  </article>;
}
export function ActionDetail({ item, close, showTimings = false }: { item: Action; close: () => void; openIncident?: (id: string) => void; showTimings?: boolean }) {
  const initial = item.evaluation;
  const detail = useQuery({ queryKey: ["evaluation", initial?.id], queryFn: () => api<SafetyEvaluation & Assessment>(`/safety/evaluations/${initial!.id}`), enabled: Boolean(initial) });
  const e = detail.data ?? initial, client = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function reassess() {
    setBusy(true);
    try { await api(`/safety/evaluations/${e!.id}/retry`, { method: "POST" }); await client.invalidateQueries(); setError("Shadow review queued. Original action remains blocked."); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <section className="inspection-detail" aria-label="Action details"><div className="modal-heading"><div><h2 id="dialog-title">{item.tool_name} request</h2></div><button className="icon-button" aria-label="Close action details" onClick={close}><X size={20} /></button></div><div className="safety-detail">
    <div className="action-metadata"><Outcome state={currentOutcome(e, item.safety_state)} />{e?.result && <><ActionSeverity evaluation={e} />{e.result.suspicious && <span className="incident-suspicion">Suspicious</span>}</>}{e?.result?.source === "debug" && <span className="debug-badge">Debug</span>}<time>{new Date(item.occurred_at).toLocaleString()}</time></div>

    {detail.data && e?.status !== "awaiting_review" && <ActionCode action={detail.data.snapshot.action} />}
    {detail.error && <p className="error">{detail.error.message}</p>}
    {e ? <>
      {e.status === "awaiting_review" ? <ApprovalCard item={{ ...item, evaluation: e }} /> : <p className="detail-reason">{e.result?.reason || e.error || "Evaluation in progress."}</p>}
      <dl className="decision-facts decision-summary" data-tour="decisions">
        <div><dt>{e.result?.source === "debug" ? "Debug" : e.result?.source === "policy" ? "Policy" : e.result?.source === "rules" ? "Rules" : "Judge"}</dt><dd><DecisionStatus value={e.result?.recommendation}>{e.result ? ({ allow: "Allow", review: "Review", deny: "Deny" }[e.result.recommendation] ?? e.result.recommendation) : "Not completed"}</DecisionStatus></dd></div>
        <div><dt>Human decision</dt><dd><DecisionStatus value={e.human_decision}>{e.human_decision === "approve" ? "Approved" : e.human_decision === "deny" ? "Denied" : "None"}</DecisionStatus></dd></div>
        <div><dt>Hook returned</dt><dd><DecisionStatus value={e.gate?.decision}>{e.gate ? ({ pass: "Released", deny: "Blocked", error: "Failed", expired: "Expired" }[e.gate.decision] ?? "Unknown") : "Not confirmed"}</DecisionStatus></dd></div>
        <div><dt>Execution</dt><dd><DecisionStatus value={item.execution_outcome}>{({ requested: "Not confirmed", succeeded: "Succeeded", failed: "Failed", completed: "Completed" }[item.execution_outcome || ""] ?? "Unknown")}</DecisionStatus></dd></div>
      </dl>
      {e.decision === "expired" && <p className="error">Expired. Submit a new tool request; this action cannot resume.</p>}
      {e.result?.recommendation === "review" && e.decision === "deny" && !e.human_decision && <p className="safety-muted">Review requested; blocked by the previous policy.</p>}
      {e.rules.policy && <p className="safety-muted">Policy v{e.rules.policy.version} · {e.rules.policy.reason}</p>}{e.rules.trial && <p className="safety-muted">Shadow trial v{e.rules.trial.version}: {e.rules.trial.decision === "none" ? "no match" : `would ${e.rules.trial.decision}`}</p>}
      <details className="safety-technical" open={showTimings || undefined}><summary>Technical details</summary><p>{e.result?.source === "rules" ? "Deterministic rules" : e.model} · {e.policy_version} · {e.latency_ms ?? "—"} ms</p>
        {detail.data?.timings && <dl className="decision-facts">{Object.entries(detail.data.timings).map(([name, value]) => <div key={name}><dt>{({ intake_ms: "Intake", rules_ms: "Rules", queue_ms: "Initial queue", model_ms: "All model attempts", human_ms: "Human response", publication_ms: "Reply publication", delivery_ms: "Reply delivery", pause_ms: "Total pause", decision_ms: "Decision time", review_remaining_ms: "Review window" } as Record<string, string>)[name]}</dt><dd>{value === null ? "—" : `${(value / 1000).toFixed(2)} s`}</dd></div>)}</dl>}
        <ol className="safety-lifecycle">{[["Requested", e.created_at], ["Judge finished", e.completed_at], ["Gate decision", e.decision_at], ["Hook returned", e.returned_at]].map(([label, at]) => <li key={label} className={at ? "reached" : ""}><strong>{label}</strong><span>{at ? new Date(at).toLocaleTimeString() : "—"}</span></li>)}</ol>
        {e.rules.findings.map((f, i) => <p key={i}>{f.reason}</p>)}{e.result?.evidence.map((text, i) => <p key={i}>{text}</p>)}
        {!!e.result?.missing_context.length && <p>Missing context: {e.result.missing_context.join("; ")}</p>}
        {e.error && <p className="error">{e.error}</p>}{e.reviewed_at && <p>Human decision at {new Date(e.reviewed_at).toLocaleString()}</p>}
        {detail.data && <pre className="hook-config">{JSON.stringify({ context: detail.data.snapshot, attempts: detail.data.attempt_history, diagnostics: e.diagnostics }, null, 2)}</pre>}
        {(e.status === "failed" || e.status === "skipped") && <><button className="secondary" disabled={busy} onClick={reassess}>Review again in shadow mode</button><p className="safety-muted">Sends assessed context to the configured judge provider again. Cannot resume this action.</p></>}{error && <p role="status">{error}</p>}
      </details>
    </> : <p>No assessment recorded for this action.</p>}
  </div></section>;
}
export function SafetyWorkspace({ connections, refresh, notify, notifications, demo = false }: { demo?: boolean; notifications: SafetyNotifications; connections: Connection[]; refresh: () => void; notify: (message: string) => void }) {
  const inspector = useRef<HTMLElement>(null);
  const [policies, setPolicies] = useState(false);
  const [policyContext, setPolicyContext] = useState<{ ruleId: string; incidentId: string } | null>(null);
  const [section, setSection] = useState<"incidents" | "history">(new URLSearchParams(location.hash.split("?")[1]).get("view") === "history" ? "history" : "incidents");
  const [incident, setIncident] = useState<string | null>(new URLSearchParams(location.hash.split("?")[1]).get("incident"));
  const incidentCounts = useQuery({ queryKey: ["incidents", "count"], queryFn: () => api<{ total: number }>("/safety/incidents?limit=1"), refetchInterval: 3000 });
  function openIncident(id: string | null) { setIncident(id); setSection("incidents"); window.history.replaceState(null, "", id ? `#safety?incident=${encodeURIComponent(id)}` : "#safety"); }
  function openHistory() { setSection("history"); window.history.replaceState(null, "", "#safety?view=history"); }
  useEffect(() => { const navigate = () => { const args = new URLSearchParams(location.hash.split("?")[1]); if (args.has("incident")) openIncident(args.get("incident")); }; window.addEventListener("hashchange", navigate); return () => window.removeEventListener("hashchange", navigate); }, []);
  const [settings, setSettings] = useState(false), [configuring, setConfiguring] = useState<Connection | null>(null);
  const [connection, setConnection] = useState(""), [range, setRange] = useState<Range>(FIT), [outcome, setOutcome] = useState(""), [offset, setOffset] = useState(0), [opened, setOpened] = useState<Action | null>(null);
  const status = useQuery({ queryKey: ["safety"], queryFn: () => api<SafetyStatus>("/safety") });
  const [tool, setTool] = useState("");
  const [reviewOffset, setReviewOffset] = useState(0);
  const approvals = useQuery({ queryKey: ["safety-actions", "live", reviewOffset], queryFn: () => api<Actions>(`/safety/actions?safety_state=awaiting_review&offset=${reviewOffset}`) });
  const params = new URLSearchParams({ connection, tool, ...rangeQuery(range) });
  const chart = useTimeChart(params.toString());
  const metrics = chart.result;
  const { bucket, setBucket, drag, setDrag } = chart;
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const historyScope = chart.narrow.toString();
  const scoped = new URLSearchParams(historyScope);
  scoped.set("tool", tool); scoped.set("safety_state", outcome); scoped.set("offset", String(offset));
  // Polling can advance the chart's time bounds without changing the user's
  // selection. Keep the current rows while that same scope refreshes.
  const actionScope = JSON.stringify({ connection, tool, range, outcome, offset, bucket, interval: chart.interval, viewport: chart.viewport });
  const actions = useQuery({
    queryKey: ["safety-actions", "history", actionScope, scoped.toString()],
    queryFn: () => api<Actions>(`/safety/actions?${scoped}`),
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === actionScope ? previous : undefined,
  });
  useEffect(() => { setOffset(0); setBucket(null); }, [connection, range]);
  useEffect(() => { setOffset(0); setOpened(null); }, [outcome, tool, connection, range, bucket, chart.interval, chart.viewport?.start, chart.viewport?.end]);
  useEffect(() => {
    if (!opened) return;
    inspector.current?.focus({ preventScroll: true });
    if (matchMedia("(max-width: 700px)").matches) inspector.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [opened?.event_id]);
  function closeInspection() {
    const row = document.getElementById(`safety-row-${opened?.event_id}`);
    setOpened(null); row?.focus({ preventScroll: true });
    if (matchMedia("(max-width: 700px)").matches) row?.scrollIntoView({ block: "nearest" });
  }
  useEffect(() => { if (reviewOffset && approvals.data && reviewOffset >= approvals.data.total) setReviewOffset(0); }, [reviewOffset, approvals.data]);
  useEffect(() => {
    const reveal = () => {
      const id = new URLSearchParams(location.hash.split("?")[1]).get("review");
      const index = notifications.items.findIndex(item => item.evaluation.id === id);
      if (index >= 0 && Math.floor(index / 20) * 20 !== reviewOffset) { setReviewOffset(Math.floor(index / 20) * 20); return; }
      const card = id && document.getElementById(`review-${id}`);
      if (card) { card.scrollIntoView({ block: "center" }); card.focus({ preventScroll: true }); }
    };
    reveal(); window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [approvals.data?.items.map(item => item.event_id).join(","), notifications.items.map(item => item.evaluation.id).join(","), reviewOffset]);
  const ready = (status.data?.debug?.enabled || status.data?.key_configured) && Boolean(status.data?.workers.length);
  const visibleSeries = SAFETY_SERIES.filter(s => !outcome || s.key === outcome);
  const navigatorData = chart.overview.data && { ...chart.overview.data, series: chart.overview.data.series.map(row => ({ ...row, actions: outcome ? row.safety?.[outcome] ?? 0 : row.actions })) };
  const bars = metrics.data?.series.map(row => ({ time: row.time, ...row.safety })) ?? [];
  if (policies) return <SafetyPolicies connections={connections} attention={policyContext} close={() => { setPolicies(false); setPolicyContext(null); }} />;
  return <div className="safety-simple">
    <div className="safety-topline" aria-label="Safety evaluation status"><span><ShieldCheck size={17} /><i className={`status-dot ${demo || ready ? "" : "red"}`} />{demo ? "Scripted demo · no API key needed" : status.isPending ? "Connecting…" : status.error ? "Status unavailable" : status.data?.debug?.enabled ? `Debug mode · Forced ${status.data.debug.result}` : !status.data?.key_configured ? "Waiting for judge API key" : !status.data.workers.length ? "Worker offline" : "Judge online"}</span><div className="safety-top-actions"><button className="secondary" disabled={demo} title={demo ? "Configuration is disabled in the sample demo" : undefined} onClick={() => { setPolicyContext(null); setPolicies(true); }}>Policies</button><button className="secondary" onClick={notifications.toggle} disabled={demo || !notifications.supported}>{notifications.enabled ? <BellRing size={15} /> : <Bell size={15} />}{notifications.enabled ? "Alerts on" : "Enable notifications"}</button><button className="secondary" disabled={demo} title={demo ? "Live integrations are disabled in the sample demo" : undefined} onClick={() => setSettings(true)}><Settings2 size={15} />Settings</button></div></div>
    {notifications.error && <p className="error" role="alert">{notifications.error}</p>}
    <section className="live-decisions" aria-label="Awaiting human decisions"><div className="safety-section-title"><h2>Needs your decision {Boolean(approvals.data?.total) && <span className="count">{approvals.data!.total}</span>}</h2><small>{demo ? "Demo · saved decisions only" : "Live · all connections"}</small></div>
      {approvals.error ? <p className="error">{approvals.error.message}</p> : approvals.isPending ? <p className="safety-muted">Loading requests…</p> : approvals.data?.total === 0 ? <div className="decisions-clear"><CheckCircle2 size={19} />No actions waiting for approval</div> : <div className="review-grid">{approvals.data?.items.map(item => <ApprovalCard key={item.event_id} item={item} />)}</div>}
      {!!approvals.data && approvals.data.total > 20 && <div className="safety-pager"><button disabled={!reviewOffset} onClick={() => setReviewOffset(Math.max(0, reviewOffset - 20))}>Previous</button><button disabled={reviewOffset + 20 >= approvals.data.total} onClick={() => setReviewOffset(reviewOffset + 20)}>Next</button></div>}
    </section>
    <div className="incident-view-tabs" aria-label="Safety views"><button className={section === "incidents" ? "selected" : ""} aria-pressed={section === "incidents"} onClick={() => openIncident(null)}>Incidents{!!incidentCounts.data?.total && <span>{incidentCounts.data.total}</span>}</button><button className={section === "history" ? "selected" : ""} aria-pressed={section === "history"} onClick={openHistory}>Action history</button></div>
    {section === "incidents" ? <Incidents connections={connections} selected={incident} open={openIncident} history={openHistory} reviewRule={(ruleId, incidentId) => { setPolicyContext({ ruleId, incidentId }); setPolicies(true); }} settings={() => setSettings(true)} /> : <>
    <section className="panel safety-history" aria-label="Action history"><div className="safety-history-heading"><h2>Action history</h2><div><select aria-label="Filter connection" value={connection} onChange={e => setConnection(e.target.value)}><option value="">All connections</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><TimeRange value={chart.zoomed && chart.data ? { ...chart.data.viewport, label: "Custom range" } : range} onChange={r => { chart.reset(); setRange(r); }} /></div></div>
      <div className="outcome-filters" aria-label="Safety outcomes in selected scope"><button aria-pressed={!outcome} onClick={() => setOutcome("")}>All <b>{metrics.data?.actions ?? 0}</b></button>{SAFETY_SERIES.map(s => <button key={s.key} aria-pressed={outcome === s.key} title={explanations[s.key]} onClick={() => setOutcome(outcome === s.key ? "" : s.key)}><i style={{ background: s.color }} />{labels[s.key]} <b>{metrics.data?.safety?.[s.key] ?? 0}</b></button>)}</div>
      {metrics.error && <p className="error">{metrics.error.message}</p>}
      <TimeChartControls chart={chart} />
      {!!metrics.data?.actions && <>
        <TimeChartCaption chart={chart} />
        <div className="safety-history-chart signal-plot" data-testid="safety-chart" aria-label="Action outcomes over time" onContextMenu={chart.onContextMenu} onMouseDownCapture={e => { if (e.button !== 0) e.stopPropagation(); }} onMouseUpCapture={e => { if (e.button !== 0) e.stopPropagation(); }} onMouseMoveCapture={e => setPointer({ x: e.clientX, y: e.clientY })}>
          <ResponsiveContainer width="100%" height="100%"><ComposedChart data={bars} margin={{ right: 24, top: 8 }}
            onMouseDown={s => { if (s.activeLabel != null) setDrag({ start: Number(s.activeLabel), end: Number(s.activeLabel) }); }}
            onMouseMove={s => { if (drag && s.activeLabel != null) setDrag({ ...drag, end: Number(s.activeLabel) }); }}
            onMouseUp={() => chart.finishDrag()} onMouseLeave={() => setDrag(null)}>
            <XAxis dataKey="time" interval="preserveStartEnd" tickFormatter={value => new Date(value).toLocaleString(undefined, metrics.data!.interval_seconds < 86400 ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" })} minTickGap={70} tickLine={false} axisLine={false} />
            <YAxis allowDecimals={false} width={36} tickLine={false} axisLine={false} />
            <Tooltip content={({ active, payload }) => {
              const row = payload?.[0]?.payload;
              return active && row ? <ChartTooltip point={pointer} className="safety-chart-tooltip"><strong>{new Date(row.time).toLocaleString()} - {new Date(Math.min(Date.parse(metrics.data!.viewport.end), row.time + metrics.data!.interval_seconds * 1000)).toLocaleString()}</strong>{visibleSeries.filter(s => row[s.key] > 0).map(s => <SeriesTooltipRow key={s.key} label={labels[s.key]} color={s.color} value={row[s.key]} />)}</ChartTooltip> : null;
            }} />
            {visibleSeries.map(s => <Bar key={s.key} dataKey={s.key} name={labels[s.key]} stackId="outcome" fill={s.color} maxBarSize={18} isAnimationActive={false}>{bars.map(row => <Cell key={row.time} opacity={bucket === null || bucket === row.time ? 1 : 0.25} />)}</Bar>)}
            {drag && drag.start !== drag.end && <ReferenceArea x1={Math.min(drag.start, drag.end)} x2={Math.max(drag.start, drag.end)} fill="#536abd" fillOpacity={0.18} />}
          </ComposedChart></ResponsiveContainer>
        </div>
        {navigatorData && <RangeNavigator overview={navigatorData} viewport={metrics.data.viewport} interval={Number(chart.interval)} onChange={chart.windowTo} kind="actions" />}
      </>}
      </section>
    <div className="safety-history-workbench">
    <section className="panel safety-records" aria-label="History results">
      <div className="safety-records-heading"><h2>Actions</h2><label className="safety-tool-search"><Search size={15} /><input aria-label="Find a tool" placeholder="Find a tool…" value={tool} onChange={e => setTool(e.target.value)} /></label></div>
      <div className="safety-action-list" aria-label="Safety actions">{actions.error ? <p className="error">{actions.error.message}</p> : actions.isPending ? <p>Loading actions…</p> : actions.data?.total === 0 ? <p className="history-empty">No actions in this selection</p> : actions.data?.items.map(item => <button id={`safety-row-${item.event_id}`} className="safety-action-row" aria-pressed={opened?.event_id === item.event_id} key={item.event_id} onClick={() => setOpened(item)}><div><span className="action-row-identity"><strong>{item.tool_name}</strong><span>{item.title}</span></span><span className="action-row-reason">{item.evaluation?.result?.reason || item.evaluation?.error || "No assessment available"}</span><span className="action-metadata"><Outcome state={item.safety_state} /><ActionSeverity evaluation={item.evaluation} />{item.evaluation?.result?.source === "debug" && <span className="debug-badge">Debug</span>}</span></div><time>{new Date(item.occurred_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><ChevronRight size={16} /></button>)}</div>
      {!!actions.data?.total && <div className="safety-pager"><small>{offset + 1}–{Math.min(offset + 20, actions.data.total)} of {actions.data.total} actions</small>{actions.data.total > 20 && <><button className="secondary" disabled={!offset} onClick={() => setOffset(offset - 20)}>Previous</button><button className="secondary" disabled={offset + 20 >= actions.data.total} onClick={() => setOffset(offset + 20)}>Next</button></>}</div>}
    </section>
    <aside ref={inspector} tabIndex={-1} className="panel safety-inspector" aria-label="Action inspector">{opened ? <ActionDetail key={opened.event_id} item={opened} close={closeInspection} openIncident={openIncident} /> : <div className="safety-inspector-empty"><Search size={30} strokeWidth={1.4} /><strong>Select an action to inspect</strong><span>Command, judge decision and outcome</span></div>}</aside>
    </div>
    </>}
    {settings && <SafetySettings status={status.data} error={status.error?.message} connections={connections} notifications={notifications} close={() => setSettings(false)} configure={connection => { setSettings(false); setConfiguring(connection); }} />}
    {configuring && <HookSetup connection={configuring} close={() => { setConfiguring(null); setSettings(true); }} done={() => { setConfiguring(null); setSettings(true); refresh(); notify("Protection saved. Restart provider sessions and review Codex hooks in /hooks."); }} />}
  </div>;
}
