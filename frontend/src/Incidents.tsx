import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  FolderSearch,
} from "lucide-react";
import { api, json, type Connection } from "./api";
import { Modal } from "./ui";
import { ActionDetail, currentOutcome, type Action } from "./SafetyView";

type IncidentStatus = "new" | "investigating" | "resolved";
type Incident = {
  id: string;
  title: string;
  connection_id: string;
  connection_name: string;
  kind: string;
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
type Detail = Incident & {
  followup: { changed: boolean; message: string; applied_at?: string } | null;
  actions: IncidentAction[];
  related: Incident[];
  nearby: Incident[];
  activity: {
    id: number;
    kind: string;
    text: string;
    actor: string;
    created_at: string;
  }[];
  activity_total: number;
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

export function IncidentActionMenu({
  eventId,
  tool,
  open,
}: {
  eventId: number;
  tool: string;
  open: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false),
    [title, setTitle] = useState(`${tool || "Tool"} requests to investigate`),
    [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const client = useQueryClient();
  const choices = useQuery({
    queryKey: ["incident-targets", eventId],
    queryFn: () => api<Listing>(`/safety/incidents/for-action/${eventId}`),
    enabled: visible,
  });
  async function save() {
    setBusy(true);
    setError("");
    try {
      const row = await api<Incident>(
        target ? `/safety/incidents/${target}/actions` : "/safety/incidents",
        json(
          "POST",
          target ? { event_id: eventId } : { event_id: eventId, title },
        ),
      );
      await client.invalidateQueries({ queryKey: ["incidents"] });
      setVisible(false);
      open(row.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="secondary" onClick={() => setVisible(true)}>
        <FolderSearch size={15} />
        Save for review
      </button>
      {visible && (
        <Modal close={() => !busy && setVisible(false)}>
          <form
            className="policy-modal-content"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <h2 id="dialog-title">Save this request for review</h2>
            <label className="incident-field">
              Save to
              <select
                aria-label="Save to"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Start a new item</option>
                {choices.data?.items.map((row) => (
                  <option value={row.id} key={row.id}>
                    {row.title}
                  </option>
                ))}
              </select>
            </label>
            {!target && (
              <label className="incident-field">
                Title
                <input
                  required
                  maxLength={200}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
            )}
            <p>
              Items shown here belong to this connection. Adding an action
              doesn’t change its decision.
            </p>
            {choices.error && (
              <p className="error">Could not load saved items.</p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="policy-modal-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setVisible(false)}
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={busy || (!target && !title.trim())}
              >
                {target ? "Attach action" : "Save request"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

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
    [connection, setConnection] = useState(""),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0);
  const params = new URLSearchParams({
    status,
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
  }, [status, connection, search]);
  useEffect(() => {
    if (offset && rows.data && offset >= rows.data.total) setOffset(0);
  }, [offset, rows.data]);
  return (
    <section className="attention-workspace" aria-label="Needs attention">
      <div className="safety-history-heading attention-heading">
        <div>
          <h2>Needs attention</h2>
          <p className="safety-muted">
            Repeated interruptions and problems worth a closer look.
          </p>
        </div>
        <select
          aria-label="Attention status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="open">Current</option>
          <option value="resolved">Dismissed or resolved</option>
          <option value="all">All</option>
        </select>
      </div>
      <div className="attention-filters">
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
      <div className="safety-history-workbench">
        <div className="safety-records panel attention-list">
          {rows.error ? null : rows.isPending ? (
            <p className="safety-muted">Loading…</p>
          ) : !rows.data?.total ? (
            <div className="attention-empty">
              <CheckCircle2 size={28} />
              <h3>
                {search || connection || status !== "open"
                  ? "No matching items"
                  : "Nothing needs attention"}
              </h3>
              <p>
                {search || connection || status !== "open"
                  ? "Try another filter."
                  : "Repeated blocks, approval requests and service failures will appear here. Individual requests stay in action history."}
              </p>
              <button className="secondary" onClick={props.history}>
                View action history
              </button>
            </div>
          ) : (
            rows.data.items.map((row) => (
              <button
                key={row.id}
                className="safety-action-row attention-row"
                aria-pressed={props.selected === row.id}
                onClick={() => props.open(row.id)}
              >
                <span className="attention-row-title">{row.headline}</span>
                <span className="attention-row-copy">{row.explanation}</span>
                <span className="attention-meta">
                  {row.connection_name} · {row.action_count} requests ·{" "}
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
              <h3>A useful next step</h3>
              <p>
                Select an item to review the affected requests, adjust a
                matching rule, or check what held things up.
              </p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function AttentionDetail({
  id,
  open,
  history,
  reviewRule,
  settings,
}: AttentionProps & { id: string }) {
  const [offset, setOffset] = useState(0),
    [activityOffset, setActivityOffset] = useState(0),
    [note, setNote] = useState("");
  const [selected, setSelected] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["incidents", id, offset, activityOffset],
    queryFn: () =>
      api<Detail>(
        `/safety/incidents/${id}?offset=${offset}&activity_offset=${activityOffset}`,
      ),
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
  async function work(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      await client.invalidateQueries({ queryKey: ["incidents"] });
      setBusy(false);
    }
  }
  return (
    <section
      className="attention-detail inspection-detail"
      aria-label="Attention details"
    >
      <button className="text-button" onClick={() => open(null)}>
        <ArrowLeft size={14} />
        Back to list
      </button>
      {query.error && (
        <p className="error" role="alert">
          {query.error.message}
        </p>
      )}
      {!row ? (
        !query.error && <p>Loading details…</p>
      ) : (
        <>
          <span className="attention-meta">
            {row.connection_name} ·{" "}
            {row.kind === "service" ? "Service problem" : "Requests to review"}
          </span>
          <h2 ref={heading} tabIndex={-1}>
            {row.headline}
          </h2>
          <p>{row.explanation}</p>
          <p className="attention-meta">
            {row.action_count} {row.action_count === 1 ? "request" : "requests"}{" "}
            ·{" "}
            {row.session_count === 1
              ? row.session_title
              : `${row.session_count} sessions`}
          </p>
          {row.resurfaced && row.status !== "resolved" && (
            <p className="policy-feedback">{row.resurfaced}</p>
          )}
          <div className="attention-actions">
            {row.rule && (
              <button
                className="primary"
                onClick={() => reviewRule(row.rule!.id, id)}
              >
                Review rule
              </button>
            )}
            {row.next_step === "diagnostics" && (
              <button
                className="primary"
                onClick={() => setSelected(row.actions[0]?.event_id ?? null)}
              >
                See where time went
              </button>
            )}
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void work(() =>
                  api(
                    `/safety/incidents/${id}`,
                    json("PATCH", {
                      revision: row.revision,
                      status: row.status === "resolved" ? "new" : "resolved",
                      resolution:
                        row.status === "resolved" ? null : "dismissed",
                    }),
                  ),
                )
              }
            >
              {row.status === "resolved" ? "Show again" : "Dismiss"}
            </button>
          </div>
          {row.status === "resolved" ? (
            <p className="safety-muted" role="status">
              {row.resolution !== "dismissed"
                ? "Resolved. You can show this item again whenever you need it."
                : row.signature
                  ? "Dismissed. New repeated activity can bring this item back."
                  : "Dismissed. Saved in history for whenever you need it."}
            </p>
          ) : (
            <p className="safety-muted">
              Dismissing this item leaves rules and pending approvals as they
              are.
            </p>
          )}
          {row.followup?.changed && (
            <div className="attention-followup">
              <strong>Since the rule changed</strong>
              {row.followup.applied_at && (
                <small>{date(row.followup.applied_at)}</small>
              )}
              <p>{row.followup.message}</p>
              <small>
                This describes later requests on this connection; it doesn’t
                prove the original problem is fixed.
              </small>
            </div>
          )}
          {row.next_step === "diagnostics" && (
            <button className="text-button" onClick={settings}>
              Open protection settings
            </button>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <h3>Affected requests</h3>
          {row.actions.map((action) => (
            <div className="attention-evidence" key={action.link_id}>
              <button
                className="attention-evidence-toggle"
                aria-expanded={selected === action.event_id}
                onClick={() =>
                  setSelected(
                    selected === action.event_id ? null : action.event_id,
                  )
                }
              >
                <strong>{action.tool_name || "Request"}</strong>
                <span>
                  {outcomeLabels[
                    currentOutcome(action.evaluation, action.safety_state)
                  ] || currentOutcome(action.evaluation, action.safety_state)}
                </span>
                <small>{date(action.occurred_at)}</small>
              </button>
              {selected === action.event_id && (
                <>
                  <ActionDetail item={action} close={() => setSelected(null)} showTimings={row.kind === "service"} />
                  {!action.evaluation && action.snapshot && <pre className="hook-config">{action.snapshot.action}</pre>}
                  <a
                    className="text-button"
                    href={`#explorer?session=${encodeURIComponent(action.session_id)}&event=${action.event_id}`}
                  >
                    Open conversation <ArrowUpRight size={13} />
                  </a>
                  {action.source === "manual" && row.status !== "resolved" && (
                    <button
                      className="text-button"
                      disabled={busy}
                      aria-label={`Detach action ${action.event_id}`}
                      onClick={() =>
                        void work(() =>
                          api(
                            `/safety/incidents/${id}/actions/${action.link_id}`,
                            { method: "DELETE" },
                          ),
                        )
                      }
                    >
                      Remove from this item
                    </button>
                  )}
                </>
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
                Previous requests
              </button>
              <button
                disabled={offset + 20 >= row.action_count}
                onClick={() => {
                  setOffset(offset + 20);
                  setSelected(null);
                }}
              >
                Next requests
              </button>
            </div>
          )}
          <details className="attention-more">
            <summary>Notes and activity</summary>
            <p className="safety-muted">{row.grouping_reason}</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void work(async () => {
                  await api(
                    `/safety/incidents/${id}/notes`,
                    json("POST", { text: note }),
                  );
                  setNote("");
                });
              }}
            >
              <label className="incident-field">
                Add a note
                <textarea
                  value={note}
                  maxLength={10000}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <button className="secondary" disabled={busy || !note.trim()}>
                Save note
              </button>
            </form>
            {row.activity.map((a) => (
              <div className="attention-activity" key={a.id}>
                <p>{a.text}</p>
                <small>{date(a.created_at)}</small>
              </div>
            ))}
            {row.activity_total > 30 && (
              <div className="safety-pager">
                <button
                  disabled={!activityOffset}
                  onClick={() => setActivityOffset(activityOffset - 30)}
                >
                  Newer activity
                </button>
                <button
                  disabled={activityOffset + 30 >= row.activity_total}
                  onClick={() => setActivityOffset(activityOffset + 30)}
                >
                  Older activity
                </button>
              </div>
            )}
            <button className="text-button" onClick={history}>
              Add requests from history
            </button>
          </details>
        </>
      )}
    </section>
  );
}
