import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  FolderSearch,
  Sparkles,
  ArrowDown,
  Archive,
  RotateCcw,
} from "lucide-react";
import { api, json, type Connection } from "./api";
import { Modal } from "./ui";
import { ActionDetail, currentOutcome, type Action } from "./SafetyView";
import { DecisionStatus } from "./DecisionStatus";

type IncidentStatus = "new" | "investigating" | "resolved";
type Incident = {
  id: string;
  title: string;
  connection_id: string;
  connection_name: string;
  kind: string;
  severity: string;
  suspicious: boolean;
  allowed_flagged: number;
  released: number;
  blocked: number;
  status: IncidentStatus;
  resolution: string | null;
  revision: number;
  grouping_reason: string;
  signature: string | null;
  action_count: number;
  created_at: string;
  last_activity_at: string;
  previous_id: string | null;
  headline: string;
  explanation: string;
  next_step: string;
  rule: { id: string; name: string } | null;
  session_count: number;
  session_title: string | null;
  resurfaced: string | null;
  first_request_at: string | null;
  last_request_at: string | null;
};
type Listing = {
  items: Incident[];
  total: number;
  counts: Record<string, number>;
};
type IncidentAction = Action & {
  link_id: number;
  source: string;
  session_id: string;
  snapshot: {
    action: string;
    context?: { role: string; text: string }[];
    user_intent?: { text: string }[];
  } | null;
};
type Evidence = {
  event_id: number;
  session_id: string;
  session_title: string;
  role: string;
  kind: string;
  text: string;
  occurred_at: string;
  flagged: boolean;
  truncated?: boolean;
  assessment?: {
    source?: string;
    recommendation: string;
    suspicious: boolean;
    severity: string;
    risk?: string;
    reason: string;
  };
  gate?: {
    mode: string;
    decision: string | null;
    human_decision: string | null;
    status: string;
    receipt_decision?: string;
    returned_at?: string;
  };
  execution?: { hook_state: string | null };
};
type Analysis = {
  status: string;
  model?: string;
  stale: boolean;
  analyzed_at?: string;
  error?: string;
  evidence?: { events: Evidence[] };
  result: {
    summary: string;
    findings: { text: string; evidence_ids: number[] }[];
    recommendations: { text: string; evidence_ids: number[] }[];
  } | null;
};
type Detail = Incident & {
  timeline: { events: Evidence[]; truncated: boolean; notice: string };
  analysis: Analysis;
  followup: { changed: boolean; message: string; applied_at?: string } | null;
  actions: IncidentAction[];
};
const outcomeLabels: Record<string, string> = {
  denied: "Blocked",
  released: "Released",
  error: "Failed / expired",
  awaiting_review: "Awaiting approval",
  pending: "Evaluating",
  shadow: "Shadow assessment",
  unassessed: "Not assessed",
};
const date = (at: string) => new Date(at).toLocaleString();

type AttentionProps = {
  connections: Connection[];
  selected: string | null;
  open: (id: string | null) => void;
  history: () => void;
  reviewRule: (ruleId: string, incidentId: string) => void;
  settings: () => void;
};

export function Incidents(props: AttentionProps) {
  const [status, setStatus] = useState("open"),
    [severity, setSeverity] = useState(""),
    [connection, setConnection] = useState(""),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0);
  const client = useQueryClient();
  const [dismissTarget, setDismissTarget] = useState<Incident | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function dismiss(row: Incident) {
    setBusyId(row.id);
    setError("");
    try {
      await api(
        `/safety/incidents/${row.id}`,
        json("PATCH", {
          revision: row.revision,
          status: row.status === "resolved" ? "new" : "resolved",
          resolution: row.status === "resolved" ? null : "dismissed",
        }),
      );
      setDismissTarget(null);
      if (props.selected === row.id) props.open(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      await client.invalidateQueries({ queryKey: ["incidents"] });
      setBusyId(null);
    }
  }
  const params = new URLSearchParams({
    status,
    severity,
    connection,
    q: search,
    offset: String(offset),
  });
  const rows = useQuery({
    queryKey: ["incidents", params.toString()],
    queryFn: () => api<Listing>(`/safety/incidents?${params}`),
    refetchInterval: 3000,
  });
  useEffect(() => {
    setOffset(0);
  }, [status, severity, connection, search]);
  useEffect(() => {
    if (offset && rows.data && offset >= rows.data.total) setOffset(0);
  }, [offset, rows.data]);
  return (
    <section className="attention-workspace" aria-label="Incidents">
      {dismissTarget && (
        <Modal close={() => { if (!busyId) setDismissTarget(null); }}>
          <div className="modal-heading"><h2 id="dialog-title">Dismiss this incident?</h2></div>
          <div className="incident-dismiss-body">
            <strong>{dismissTarget.headline}</strong>
            <p>This moves the incident out of Current and into Dismissed. Its evidence is kept, and you can show it again. New flagged activity may bring it back.</p>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="policy-modal-actions">
              <button className="secondary" disabled={busyId !== null} onClick={() => setDismissTarget(null)}>Cancel</button>
              <button className="primary" disabled={busyId !== null} onClick={() => void dismiss(dismissTarget)}>{busyId ? "Dismissing..." : "Dismiss incident"}</button>
            </div>
          </div>
        </Modal>
      )}
      <div className="attention-filters" role="group" aria-label="Filter incidents">
        <select
          aria-label="Attention status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="open">Current</option>
          <option value="resolved">Dismissed</option>
          <option value="all">All</option>
        </select>
        <select
          aria-label="Incident severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
        >
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <input
          aria-label="Find an item"
          placeholder="Find an item…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Attention connection"
          value={connection}
          onChange={(e) => setConnection(e.target.value)}
        >
          <option value="">All connections</option>
          {props.connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {rows.error && (
        <p className="error" role="alert">
          {rows.error.message}
        </p>
      )}
      {error && !dismissTarget && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="safety-history-workbench">
        <div className="safety-records panel attention-list">
          {rows.error ? null : rows.isPending ? (
            <p className="safety-muted">Loading…</p>
          ) : !rows.data?.total ? (
            <div className="attention-empty">
              <CheckCircle2 size={28} />
              <h3>
                {search || severity || connection || status !== "open"
                  ? "No matching items"
                  : "No flagged activity"}
              </h3>
              <p>
                {search || severity || connection || status !== "open"
                  ? "Try another filter."
                  : "When the judge flags an action, Relay gathers the surrounding conversation and explains the concern here—even if the action was allowed."}
              </p>
              <button className="secondary" onClick={props.history}>
                View action history
              </button>
            </div>
          ) : (
            rows.data.items.map((row) => (
              <div className="incident-list-card" key={row.id}>
                <button
                  className="safety-action-row attention-row"
                  data-tour-incident={row.id}
                  aria-pressed={props.selected === row.id}
                  onClick={() => props.open(row.id)}
                >
                  <span className="incident-row-flags">
                    <Severity level={row.severity} />
                    {row.suspicious && (
                      <span className="incident-suspicion">Suspicious</span>
                    )}
                  </span>
                  <span className="attention-row-title">{row.headline}</span>
                  <span className="attention-row-copy">{row.explanation}</span>
                  <span className="attention-meta">
                    {row.connection_name} · {row.action_count}{" "}
                    {row.action_count === 1 ? "request" : "requests"} ·{" "}
                    {row.session_count === 1
                      ? row.session_title
                      : `${row.session_count} sessions`}
                  </span>
                  <span className="attention-meta">
                    {row.status === "resolved"
                      ? "Dismissed / resolved · "
                      : row.resurfaced
                        ? "New activity · "
                        : ""}
                    {date(row.last_activity_at)}
                  </span>
                </button>
                <button
                  className="text-button incident-list-dismiss"
                  disabled={busyId !== null}
                  onClick={() => { setError(""); if (row.status === "resolved") void dismiss(row); else setDismissTarget(row); }}
                  title="Dismissed incidents keep their evidence. New flagged activity can bring them back."
                >
                  {row.status === "resolved" ? (
                    <RotateCcw size={14} />
                  ) : (
                    <Archive size={14} />
                  )}
                  {busyId === row.id
                    ? "Saving…"
                    : row.status === "resolved"
                      ? "Show again"
                      : "Dismiss incident"}
                </button>
              </div>
            ))
          )}
          {!!rows.data && rows.data.total > 20 && (
            <div className="safety-pager">
              <button disabled={!offset} onClick={() => setOffset(offset - 20)}>
                Previous
              </button>
              <span>
                {offset + 1}–{Math.min(offset + 20, rows.data.total)} of{" "}
                {rows.data.total}
              </span>
              <button
                disabled={offset + 20 >= rows.data.total}
                onClick={() => setOffset(offset + 20)}
              >
                Next
              </button>
            </div>
          )}
        </div>
        <aside className="safety-inspector panel attention-inspector">
          {props.selected ? (
            <AttentionDetail
              key={props.selected}
              {...props}
              id={props.selected}
            />
          ) : (
            <div className="attention-empty">
              <FolderSearch size={25} />
              <h3>The story behind the alert</h3>
              <p>
                See the conversation, why the judge flagged it, and suggested
                next steps.
              </p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function evidenceText(event: Evidence) {
  if (event.kind !== "tool_call") return event.text;
  try {
    const action = JSON.parse(event.text);
    const input = action.tool_input || action;
    const command = input.command ?? input.cmd;
    if (typeof command === "string") return command;
    const path = input.file_path ?? input.path;
    if (typeof path === "string")
      return `${action.tool_name || "File request"} ${path}`;
  } catch {
    /* A shortened action remains visible as recorded. */
  }
  return event.text;
}

export function Severity({ level }: { level: string }) {
  const safe = ["low", "medium", "high", "critical"].includes(level)
    ? level
    : "medium";
  return (
    <span
      className={`incident-severity ${safe}`}
      title="Potential impact, separate from whether the action was allowed or blocked."
    >
      {safe[0].toUpperCase() + safe.slice(1)}
    </span>
  );
}

function AttentionDetail({
  id,
  open,
  reviewRule,
  settings,
}: AttentionProps & { id: string }) {
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<number | null>(null),
    [highlight, setHighlight] = useState<number | null>(null);
  const query = useQuery({
    queryKey: ["incidents", id, offset],
    queryFn: () => api<Detail>(`/safety/incidents/${id}?offset=${offset}`),
    refetchInterval: 3000,
  });
  const row = query.data;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!row) return;
    heading.current?.focus({ preventScroll: true });
    if (matchMedia("(max-width: 700px)").matches)
      heading.current?.scrollIntoView({ block: "center" });
  }, [!!row]);
  function citations(ids: number[]) {
    return (
      <span className="incident-citations">
        {ids.map((eventId) => {
          const event =
            row?.timeline.events.find((e) => e.event_id === eventId) ??
            row?.analysis.evidence?.events.find((e) => e.event_id === eventId);
          if (!event) return null;
          return row?.timeline.events.some((e) => e.event_id === eventId) ? (
            <button
              key={eventId}
              className="text-button evidence-reference"
              onClick={() => {
                setHighlight(eventId);
                document
                  .getElementById(`incident-event-${eventId}`)
                  ?.focus({ preventScroll: true });
                document
                  .getElementById(`incident-event-${eventId}`)
                  ?.scrollIntoView({ block: "center", behavior: "smooth" });
              }}
            >
              Evidence {eventId}
              <ArrowDown size={11} />
            </button>
          ) : (
            <a
              key={eventId}
              className="text-button evidence-reference"
              href={`#explorer?session=${encodeURIComponent(event.session_id)}&event=${eventId}`}
            >
              Evidence {eventId}
              <ArrowUpRight size={11} />
            </a>
          );
        })}
      </span>
    );
  }
  const analysis = row?.analysis;
  const ready = analysis?.result && !analysis.stale ? analysis.result : null;
  const analysisMessage =
    analysis?.status === "needs_key"
      ? "Add a judge API key in Safety settings for automatic analysis. The recorded evidence is available below."
      : analysis?.status === "failed" || analysis?.status === "unavailable"
        ? analysis.error ||
          "Analysis is unavailable. The recorded evidence is below."
        : analysis?.stale
          ? "New activity arrived. An updated analysis is queued."
          : analysis?.status === "running"
            ? "The judge is reviewing the recorded activity. You can inspect the evidence now."
            : analysis?.status === "pending"
              ? "Automatic analysis is queued. You can inspect the evidence now."
              : analysis?.error ||
                "Analysis has not run for this incident yet.";
  const citedIds = new Set(
    [...(ready?.findings ?? []), ...(ready?.recommendations ?? [])].flatMap(
      (point) => point.evidence_ids,
    ),
  );
  const timelineParts: { context: boolean; events: Evidence[] }[] = [];
  for (const event of row?.timeline.events ?? []) {
    const context = !event.flagged && !citedIds.has(event.event_id);
    const previous = timelineParts[timelineParts.length - 1];
    if (context && previous?.context) previous.events.push(event);
    else timelineParts.push({ context, events: [event] });
  }
  function renderEvent(event: Evidence) {
    return (
      <li
        key={event.event_id}
        id={`incident-event-${event.event_id}`}
        data-tour={event.assessment?.recommendation === "review" ? "review-request" : undefined}
        tabIndex={-1}
        className={`${event.flagged ? "flagged" : ""} ${highlight === event.event_id ? "highlighted" : ""}`}
      >
        <div className="incident-event-heading">
          {citedIds.has(event.event_id) ? <span className="evidence-label">Evidence {event.event_id}</span> : <span className="context-record-label">{event.flagged ? "Flagged record" : "Context"}</span>}
          <strong>
            {event.kind === "tool_call"
              ? "Tool request"
              : event.kind === "tool_result"
                ? "Tool result"
                : event.role === "user"
                  ? "User asked"
                  : "Agent said"}
          </strong>
          {event.flagged && <span className="incident-suspicion">Flagged</span>}
          <time>{new Date(event.occurred_at).toLocaleTimeString()}</time>
        </div>
        {row!.session_count > 1 && <small>{event.session_title}</small>}
        <div className={event.truncated ? "incident-excerpt is-truncated" : "incident-excerpt"}>
          <pre className="incident-event-text">{evidenceText(event)}</pre>
          {event.truncated && <div className="incident-truncation" role="img" aria-label="Content truncated; open in conversation to read more" title="Content truncated"><span aria-hidden="true">&#8226;&#8226;&#8226;</span></div>}
        </div>
        {event.assessment && (
          <div className="incident-event-assessment">
            <Severity
              level={
                event.assessment.recommendation === "review" ||
                event.assessment.recommendation === "deny"
                  ? event.assessment.severity === "critical"
                    ? "critical"
                    : "high"
                  : event.assessment.severity ||
                    event.assessment.risk ||
                    "medium"
              }
            />
            <p>{event.assessment.reason}</p>
          </div>
        )}
        {event.assessment && (
          <div className="incident-event-outcome" data-tour={event.assessment.recommendation === "review" ? "review-decision" : undefined}>
            <span className="incident-outcome-stage">
              {event.assessment.source === "policy"
                ? "Policy"
                : event.assessment.source === "rules"
                  ? "Built-in rules"
                  : "Judge"}
              {" "}<DecisionStatus value={event.assessment.recommendation}>
              {event.assessment.recommendation === "allow"
                ? "allow"
                : event.assessment.recommendation === "review"
                  ? "review requested"
                  : event.assessment.recommendation === "deny"
                    ? "block recommended"
                    : "no verdict"}
              </DecisionStatus>
            </span>
            <DecisionStatus value={event.gate?.mode === "shadow" ? "shadow" : event.gate?.returned_at ? event.gate.receipt_decision : event.gate?.status === "awaiting_review" ? "review" : undefined}>
              {event.gate?.mode === "shadow"
                ? "Shadow assessment · did not hold this request"
                : event.gate?.returned_at &&
                    event.gate.receipt_decision === "pass"
                  ? "Release confirmed"
                  : event.gate?.returned_at &&
                      event.gate.receipt_decision === "deny"
                    ? "Block confirmed"
                    : event.gate?.status === "awaiting_review"
                      ? "Waiting for approval"
                      : "No release receipt"}
            </DecisionStatus>
            <DecisionStatus value={event.execution?.hook_state}>
              Execution:{" "}
              {(
                {
                  succeeded: "succeeded",
                  failed: "failed",
                  completed: "completed",
                  requested: "not confirmed",
                } as Record<string, string>
              )[event.execution?.hook_state || ""] || "not confirmed"}
            </DecisionStatus>
          </div>
        )}
        <a
          className="text-button"
          href={`#explorer?session=${encodeURIComponent(event.session_id)}&event=${event.event_id}`}
        >
          Open in conversation
          <ArrowUpRight size={12} />
        </a>
      </li>
    );
  }
  return (
    <section
      className="attention-detail inspection-detail"
      aria-label="Incident details"
    >
      <button className="text-button" data-tour="incident-back" onClick={() => open(null)}>
        <ArrowLeft size={14} />
        Back to incidents
      </button>
      {query.error && (
        <p className="error" role="alert">
          {query.error.message}
        </p>
      )}
      {!row ? (
        !query.error && <p>Loading the conversation…</p>
      ) : (
        <>
          <div className="incident-row-flags">
            <Severity level={row.severity} />
            {row.suspicious && (
              <span className="incident-suspicion">Suspicious</span>
            )}
            <span className="attention-meta">{row.connection_name}</span>
          </div>
          <h2 ref={heading} tabIndex={-1}>
            {row.headline}
          </h2>
          <p className="incident-reason">{row.explanation}</p>
          <div className="incident-outcomes">
            <span>
              <strong>{row.action_count}</strong>{" "}
              {row.action_count === 1 ? "request" : "requests"}
            </span>
            <span>
              <strong>{row.released}</strong> released
            </span>
            <span>
              <strong>{row.blocked}</strong> blocked
            </span>
          </div>
          {row.allowed_flagged > 0 && (
            <p className="safety-muted">
              The judge allowed{" "}
              {row.allowed_flagged === 1
                ? "a request"
                : `${row.allowed_flagged} requests`}{" "}
              while flagging a concern.
            </p>
          )}
          {row.resurfaced && row.status !== "resolved" && (
            <p className="policy-feedback">{row.resurfaced}</p>
          )}
          <div className="incident-analysis" data-tour="incident-analysis">
            <div className="incident-section-heading">
              <h3>
                <Sparkles size={15} />
                What happened
              </h3>
              <small>{analysis?.model === "scripted-demo" ? "Scripted demo analysis" : "Judge analysis"}</small>
            </div>
            {ready ? (
              <>
                <p>{ready.summary}</p>
                {ready.findings.length > 0 && (
                  <div className="incident-findings">
                    <h4>Why it matters</h4>
                    <ol className="incident-finding-list">
                      {ready.findings.map((finding, i) => (
                        <li key={i}>
                          <p>{finding.text}</p>
                          {citations(finding.evidence_ids)}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {ready.recommendations.length > 0 && (
                  <div className="incident-recommendations">
                    <h4>Suggested next steps</h4>
                    {ready.recommendations.map((recommendation, i) => (
                      <div key={i}>
                        <p>{recommendation.text}</p>
                        {citations(recommendation.evidence_ids)}
                      </div>
                    ))}
                  </div>
                )}
                <small className="attention-meta">
                  Updated{" "}
                  {analysis?.analyzed_at
                    ? date(analysis.analyzed_at)
                    : "recently"}
                </small>
              </>
            ) : (
              <>
                <p className="safety-muted" role="status">
                  {analysisMessage}
                </p>
                {analysis?.status === "needs_key" && (
                  <button className="secondary" onClick={settings}>
                    Open Safety settings
                  </button>
                )}
              </>
            )}
          </div>
          {row.rule && (
            <button
              className="secondary"
              onClick={() => reviewRule(row.rule!.id, id)}
            >
              Review matching rule
            </button>
          )}
          {row.followup?.changed && (
            <div className="attention-followup">
              <strong>Since the rule changed</strong>
              <p>{row.followup.message}</p>
            </div>
          )}
          {row.next_step === "diagnostics" && (
            <div className="attention-actions">
              <button
                className="secondary"
                onClick={() => setSelected(row.actions[0]?.event_id ?? null)}
              >
                See where time went
              </button>
              <button className="text-button" onClick={settings}>
                Protection settings
              </button>
            </div>
          )}
          <div className="incident-section-heading">
            <h3>Conversation timeline</h3>
            <small>
              {row.session_count}{" "}
              {row.session_count === 1 ? "session" : "sessions"}
            </small>
          </div>
          <ol className="incident-conversation">
            {timelineParts.map((part) =>
              part.context ? (
                <li
                  className="incident-context"
                  key={`context-${part.events[0].event_id}`}
                >
                  <details>
                    <summary>
                      <span className="context-show">Show</span>
                      <span className="context-hide">Hide</span>{" "}
                      {part.events.length} surrounding{" "}
                      {part.events.length === 1 ? "record" : "records"}
                    </summary>
                    <ol className="incident-conversation">
                      {part.events.map(renderEvent)}
                    </ol>
                  </details>
                </li>
              ) : (
                renderEvent(part.events[0])
              ),
            )}
          </ol>
          {row.timeline.truncated && (
            <p className="safety-muted">
              Showing a bounded excerpt. Open a conversation to see the full
              history.
            </p>
          )}
          {!row.timeline.events.length && (
            <p className="safety-muted">
              No conversation records are available for this incident.
            </p>
          )}
          <details
            className="incident-technical"
            open={selected !== null || undefined}
          >
            <summary data-tour="request-details">Request details</summary>
            {row.actions.map((action) => (
              <div className="attention-evidence" key={action.link_id}>
                <button
                  className="attention-evidence-toggle"
                  data-tour="action-open"
                  aria-expanded={selected === action.event_id}
                  onClick={() =>
                    setSelected(
                      selected === action.event_id ? null : action.event_id,
                    )
                  }
                >
                  <strong>{action.tool_name || "Request"}</strong>
                  <span>
                    {
                      outcomeLabels[
                        currentOutcome(action.evaluation, action.safety_state)
                      ]
                    }
                  </span>
                  <small>{date(action.occurred_at)}</small>
                </button>
                {selected === action.event_id && (
                  <ActionDetail
                    item={action}
                    close={() => setSelected(null)}
                    showTimings={row.kind === "service"}
                  />
                )}
              </div>
            ))}
            {row.action_count > 20 && (
              <div className="safety-pager">
                <button
                  disabled={!offset}
                  onClick={() => {
                    setOffset(offset - 20);
                    setSelected(null);
                  }}
                >
                  Previous
                </button>
                <button
                  disabled={offset + 20 >= row.action_count}
                  onClick={() => {
                    setOffset(offset + 20);
                    setSelected(null);
                  }}
                >
                  Next
                </button>
              </div>
            )}
          </details>
        </>
      )}
    </section>
  );
}
