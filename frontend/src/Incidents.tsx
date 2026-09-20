import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  FolderSearch,
  Link2,
  MessageSquare,
  Plus,
  Unlink,
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
  action_count: number;
  created_at: string;
  last_activity_at: string;
  previous_id: string | null;
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
const statusLabels = {
  new: "New",
  investigating: "Investigating",
  resolved: "Resolved",
};
const resolutions: Record<string, string> = {
  expected: "Expected activity",
  policy: "Policy needs adjusting",
  addressed: "Issue addressed",
  other: "Other",
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
        Add to incident
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
            <h2 id="dialog-title">Keep this action for investigation</h2>
            <label className="incident-field">
              Incident
              <select
                aria-label="Incident"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Create a new incident</option>
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
              Existing incidents shown here belong to this connection. Adding an
              action doesn’t change its decision.
            </p>
            {choices.error && (
              <p className="error">Could not load existing incidents.</p>
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
                {target ? "Attach action" : "Create incident"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export function Incidents({
  connections,
  selected,
  open,
  history,
}: {
  connections: Connection[];
  selected: string | null;
  open: (id: string | null) => void;
  history: () => void;
}) {
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
    if (offset && rows.data && offset >= rows.data.total)
      setOffset(Math.max(0, Math.floor((rows.data.total - 1) / 20) * 20));
  }, [rows.data, offset]);
  if (selected)
    return (
      <Investigation
        key={selected}
        id={selected}
        open={open}
        history={history}
      />
    );
  return (
    <section className="panel incident-inbox" aria-label="Incidents">
      <div className="incident-inbox-heading">
        <div>
          <h2>Incidents</h2>
          <p>Related requests, kept together for a closer look.</p>
        </div>
        <button className="secondary" onClick={history}>
          <Plus size={15} />
          Create from action history
        </button>
      </div>
      <div className="incident-filters">
        <label>
          Status
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            <option value="open">Open</option>
            <option value="new">New</option>
            <option value="investigating">Investigating</option>
            <option value="resolved">Resolved</option>
            <option value="all">All incidents</option>
          </select>
        </label>
        <label>
          Connection
          <select
            value={connection}
            onChange={(e) => {
              setConnection(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All connections</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="incident-search">
          Find an incident
          <input
            type="search"
            value={search}
            placeholder="Search titles…"
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
        </label>
      </div>
      {rows.error ? (
        <p className="error" role="alert">
          {rows.error.message}
        </p>
      ) : rows.isPending ? (
        <p className="safety-muted">Loading incidents…</p>
      ) : !rows.data.total ? (
        <div className="incident-empty">
          <FolderSearch size={36} strokeWidth={1.4} />
          <h3>
            {search || connection || status !== "open"
              ? "No incidents match"
              : "Nothing to investigate right now"}
          </h3>
          <p>
            {search || connection || status !== "open"
              ? "Try a different filter, or look through action history."
              : "Relay groups recorded concerns and repeated blocks or failures here. You can also start an incident from any action in history."}
          </p>
          <button className="secondary" onClick={history}>
            Browse action history
          </button>
        </div>
      ) : (
        <>
          <div className="incident-list">
            {rows.data.items.map((row) => (
              <button
                className="incident-row"
                key={row.id}
                onClick={() => open(row.id)}
              >
                <span className={`incident-kind ${row.kind}`}>
                  <FolderSearch size={20} />
                </span>
                <span className="incident-row-copy">
                  <strong>{row.title}</strong>
                  <span>
                    {row.connection_name} · {row.action_count}{" "}
                    {row.action_count === 1 ? "request" : "requests"}
                    {row.kind === "service" ? " · Service issue" : ""}
                  </span>
                  <small>Last request {date(row.last_activity_at)}</small>
                </span>
                <span className={`incident-status ${row.status}`}>
                  {statusLabels[row.status]}
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
          <div className="safety-pager">
            <small>
              {offset + 1}–{Math.min(offset + 20, rows.data.total)} of{" "}
              {rows.data.total}
            </small>
            <button
              className="secondary"
              disabled={!offset}
              onClick={() => setOffset(offset - 20)}
            >
              Previous
            </button>
            <button
              className="secondary"
              disabled={offset + 20 >= rows.data.total}
              onClick={() => setOffset(offset + 20)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Investigation({
  id,
  open,
  history,
}: {
  id: string;
  open: (id: string | null) => void;
  history: () => void;
}) {
  const [offset, setOffset] = useState(0),
    [activityOffset, setActivityOffset] = useState(0),
    [note, setNote] = useState(""),
    [resolution, setResolution] = useState("addressed"),
    [resolve, setResolve] = useState(false);
  const [selected, setSelected] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const client = useQueryClient(),
    heading = useRef<HTMLHeadingElement>(null);
  const query = useQuery({
    queryKey: ["incidents", id, offset, activityOffset],
    queryFn: () =>
      api<Detail>(
        `/safety/incidents/${id}?offset=${offset}&activity_offset=${activityOffset}`,
      ),
    refetchInterval: 3000,
  });
  const row = query.data;
  useEffect(() => {
    heading.current?.focus();
  }, [!!row]);
  useEffect(() => {
    if (row && offset >= row.action_count && offset)
      setOffset(Math.max(0, Math.floor((row.action_count - 1) / 20) * 20));
  }, [row, offset]);
  async function work(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await client.invalidateQueries({ queryKey: ["incidents"] });
      await client.invalidateQueries({ queryKey: ["incident-targets"] });
    } catch (err) {
      setError((err as Error).message);
      await client.invalidateQueries({ queryKey: ["incidents"] });
    } finally {
      setBusy(false);
    }
  }
  function change(status: IncidentStatus) {
    return work(async () => {
      await api(
        `/safety/incidents/${id}`,
        json("PATCH", {
          revision: row!.revision,
          status,
          resolution: status === "resolved" ? resolution : null,
        }),
      );
      setResolve(false);
    });
  }
  return (
    <section
      className="incident-investigation"
      aria-label="Incident investigation"
    >
      <button className="secondary" onClick={() => open(null)}>
        <ArrowLeft size={15} />
        All incidents
      </button>
      {query.error && (
        <p className="error" role="alert">
          {query.error.message}
        </p>
      )}
      {!row ? (
        <p>Loading incident…</p>
      ) : (
        <>
          <div className="panel incident-summary">
            <div className="incident-summary-heading">
              <div>
                <div className="incident-eyebrow">
                  {row.kind === "service" ? "Service issue" : "Investigation"} ·{" "}
                  {row.connection_name}
                </div>
                <h2 tabIndex={-1} ref={heading}>
                  {row.title}
                </h2>
              </div>
              <span className={`incident-status ${row.status}`}>
                {statusLabels[row.status]}
              </span>
            </div>
            <p>{row.grouping_reason}</p>
            <div className="incident-summary-meta">
              <span>
                {row.action_count} linked{" "}
                {row.action_count === 1 ? "request" : "requests"}
              </span>
              {row.first_request_at && (
                <span>First request {date(row.first_request_at)}</span>
              )}
              {row.last_request_at && (
                <span>Last request {date(row.last_request_at)}</span>
              )}
            </div>
            {row.resolution && (
              <div className="incident-resolution">
                <CheckCircle2 size={16} />
                {resolutions[row.resolution]}
              </div>
            )}
            <div className="incident-summary-actions">
              {row.status === "new" && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void change("investigating")}
                >
                  Start investigating
                </button>
              )}
              {row.status !== "resolved" ? (
                <>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={history}
                  >
                    <Link2 size={15} />
                    Attach from history
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => setResolve(!resolve)}
                  >
                    Resolve incident
                  </button>
                </>
              ) : (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void change("investigating")}
                >
                  Reopen incident
                </button>
              )}
            </div>
            {resolve && (
              <form
                className="incident-resolve-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void change("resolved");
                }}
              >
                <label className="incident-field">
                  How did this turn out?
                  <select
                    aria-label="How did this turn out?"
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                  >
                    {Object.entries(resolutions).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <p>
                  Closing this investigation doesn’t approve or retry any
                  request.
                </p>
                <div>
                  <button
                    className="secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => setResolve(false)}
                  >
                    Cancel
                  </button>
                  <button className="primary" disabled={busy}>
                    Save resolution
                  </button>
                </div>
              </form>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="incident-workbench">
            <section
              className="panel incident-timeline"
              aria-label="Incident requests"
            >
              <div className="incident-section-heading">
                <h3>Requests and evidence</h3>
                <span>{row.action_count}</span>
              </div>
              {!row.actions.length && (
                <p className="safety-muted">
                  No actions attached. Your notes and investigation history are
                  still here.
                </p>
              )}
              {row.actions.map((action) => {
                const outcome = currentOutcome(
                  action.evaluation,
                  action.safety_state,
                );
                return (
                  <article key={action.link_id} className="incident-request">
                    <div className="incident-request-heading">
                      <strong>{action.tool_name || "Tool"}</strong>
                      <span className={`incident-outcome ${outcome}`}>
                        {outcomeLabels[outcome]}
                      </span>
                    </div>
                    <p className="incident-session">
                      {action.title} · {date(action.occurred_at)}
                    </p>
                    <p className="incident-request-reason">
                      {action.evaluation?.result?.reason ||
                        action.evaluation?.error ||
                        "No assessment recorded."}
                    </p>
                    {action.snapshot && (
                      <pre className="incident-command">
                        {displayAction(action.snapshot.action)}
                      </pre>
                    )}
                    <p className="incident-execution">
                      Execution:{" "}
                      {{
                        succeeded: "succeeded",
                        completed: "completed",
                        failed: "failed",
                      }[action.execution_outcome || ""] ?? "unknown"}
                    </p>
                    <div className="incident-request-actions">
                      <button
                        className="text-button"
                        aria-expanded={selected === action.link_id}
                        onClick={() =>
                          setSelected(
                            selected === action.link_id ? null : action.link_id,
                          )
                        }
                      >
                        {selected === action.link_id
                          ? "Hide details"
                          : outcome === "awaiting_review"
                            ? "Review this request"
                            : "Inspect evidence"}
                      </button>
                      <a
                        href={`#explorer?session=${encodeURIComponent(action.session_id)}&event=${action.event_id}`}
                      >
                        Open conversation <ArrowUpRight size={13} />
                      </a>
                      <button
                        className="text-button"
                        disabled={busy}
                        aria-label={`Detach action ${action.event_id}`}
                        onClick={() =>
                          void work(async () => {
                            await api(
                              `/safety/incidents/${id}/actions/${action.link_id}`,
                              { method: "DELETE" },
                            );
                            if (selected === action.link_id) setSelected(null);
                          })
                        }
                      >
                        <Unlink size={13} />
                        Detach
                      </button>
                    </div>
                    {selected === action.link_id && (
                      <ActionDetail
                        item={action}
                        close={() => setSelected(null)}
                      />
                    )}
                  </article>
                );
              })}
              <div className="safety-pager">
                <small>
                  {row.action_count
                    ? `${offset + 1}–${Math.min(offset + 20, row.action_count)} of ${row.action_count}`
                    : "0 requests"}
                </small>
                <button
                  className="secondary"
                  disabled={!offset}
                  onClick={() => {
                    setOffset(offset - 20);
                    setSelected(null);
                  }}
                >
                  Previous
                </button>
                <button
                  className="secondary"
                  disabled={offset + 20 >= row.action_count}
                  onClick={() => {
                    setOffset(offset + 20);
                    setSelected(null);
                  }}
                >
                  Next
                </button>
              </div>
            </section>
            <aside
              className="panel incident-notes"
              aria-label="Investigation notes"
            >
              <div className="incident-section-heading">
                <h3>Your investigation</h3>
                <MessageSquare size={17} />
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void work(async () => {
                    await api(
                      `/safety/incidents/${id}/notes`,
                      json("POST", { text: note }),
                    );
                    setNote("");
                    setActivityOffset(0);
                  });
                }}
              >
                <label className="incident-field">
                  Add a note
                  <textarea
                    rows={4}
                    maxLength={4000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="What did you find?"
                  />
                </label>
                <button className="secondary" disabled={busy || !note.trim()}>
                  Save note
                </button>
              </form>
              <ol className="incident-activity">
                {row.activity.map((item) => (
                  <li
                    key={item.id}
                    className={item.kind === "note" ? "is-note" : ""}
                  >
                    <p>{item.text}</p>
                    <small>
                      {item.actor} · {date(item.created_at)}
                    </small>
                  </li>
                ))}
              </ol>
              {row.activity_total > 30 && (
                <div className="safety-pager">
                  <button
                    className="secondary"
                    disabled={!activityOffset}
                    onClick={() => setActivityOffset(activityOffset - 30)}
                  >
                    Newer
                  </button>
                  <button
                    className="secondary"
                    disabled={activityOffset + 30 >= row.activity_total}
                    onClick={() => setActivityOffset(activityOffset + 30)}
                  >
                    Older
                  </button>
                </div>
              )}
              {row.related.length > 0 && (
                <div className="incident-related">
                  <h3>Related investigations</h3>
                  {row.related.map((item) => (
                    <button
                      key={item.id}
                      className="text-button"
                      onClick={() => open(item.id)}
                    >
                      {item.title}
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
              )}
              {row.nearby?.length > 0 && (
                <div className="incident-related">
                  <h3>Possibly related</h3>
                  <p className="safety-muted">
                    Other concerns from the same session within ten minutes.
                    Kept separate until you investigate.
                  </p>
                  {row.nearby.map((item) => (
                    <button
                      key={item.id}
                      className="text-button"
                      onClick={() => open(item.id)}
                    >
                      {item.title}
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
              )}
            </aside>
          </div>
        </>
      )}
    </section>
  );
}

function displayAction(raw: string) {
  try {
    const parsed = JSON.parse(raw),
      args = parsed.tool_input ?? parsed;
    return typeof args.command === "string"
      ? args.command
      : typeof args.cmd === "string"
        ? args.cmd
        : JSON.stringify(args, null, 2);
  } catch {
    return raw;
  }
}
