import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Terminal } from "lucide-react";
import { api, type ChatEvent, type Session } from "./api";
import { Provider } from "./ui";
import { SafetyVerdict } from "./Safety";

export const ACTIONS = [
  ["", "All actions"],
  ["any", "Has tool calls"],
  ["deletion", "Deletion-related"],
  ["file_write", "File writes"],
  ["read", "Reads / searches"],
  ["shell", "Shell / execution"],
  ["network", "Network"],
  ["other", "Other tools"],
];
export function Highlight({
  text,
  q,
  mode = "words",
}: {
  text: string;
  q: string;
  mode?: string;
}) {
  if (!q) return <>{text}</>;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    mode === "contains" ? escaped : `(?<!\\w)${escaped}(?!\\w)`,
    "gi",
  );
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(regex)) {
    const i = match.index!;
    parts.push(text.slice(last, i), <mark key={i}>{match[0]}</mark>);
    last = i + match[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

export function Conversation({
  session,
  params,
  initialKind = "",
}: {
  session: Session;
  params: string;
  initialKind?: string;
}) {
  const base = new URLSearchParams(params);
  const initialQuery =
    session.match?.kind === "title" ? "" : base.get("q") || "";
  const [search, setSearch] = useState(initialQuery),
    [offset, setOffset] = useState(0),
    [kind, setKind] = useState(initialKind),
    [action, setAction] = useState(base.get("action") || ""),
    [anchor, setAnchor] = useState<number | null>(null),
    [surrounding, setSurrounding] = useState(false);
  const mode = base.get("search_mode") || "words";
  const query = new URLSearchParams(base);
  query.set("q", search);
  query.set("search_scope", "all");
  query.set("offset", String(offset));
  query.set("kind", kind);
  query.set("action", action);
  query.set("include_context", "false");
  if (surrounding) query.delete("tool");
  if (anchor) query.set("anchor", String(anchor));
  const events = useQuery({
    queryKey: ["events", session.id, query.toString()],
    queryFn: () =>
      api<{ total: number; offset: number; items: ChatEvent[] }>(
        `/sessions/${session.id}/events?${query}`,
      ),
  });
  function reset() {
    setOffset(0);
    setAnchor(null);
  }
  return (
    <div className="conversation-content">
      <div className="explorer-detail-heading">
        <Provider name={session.provider} />
        <div>
          <h2 id="dialog-title">{session.title}</h2>
          <p>
            {session.connection_name} ·{" "}
            {session.session_type === "internal_review"
              ? "Internal approval review"
              : "Local transcript"}
          </p>
        </div>
      </div>
      <div className="conversation-toolbar">
        <label className="search">
          <Search size={15} />
          <input
            aria-label="Search this conversation"
            placeholder="Find in messages and tools…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              reset();
            }}
          />
        </label>
        <select
          aria-label="Filter event type"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            reset();
          }}
        >
          <option value="">Messages + tools</option>
          <option value="message">Messages</option>
          <option value="tool_call">Tool calls</option>
          <option value="tool_result">Tool results</option>
        </select>
        <select
          aria-label="Conversation action category"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            reset();
          }}
        >
          {ACTIONS.map(([v, l]) => (
            <option value={v} key={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      {(search || kind || action || (!surrounding && base.get("tool"))) && <div className="detail-options">
        {(search || kind || action || (!surrounding && base.get("tool"))) && (
          <button
            className="secondary"
            onClick={() => {
              setAnchor(events.data?.items[0]?.id || null);
              setSearch("");
              setKind("");
              setAction("");
              setSurrounding(true);
              setOffset(0);
            }}
          >
            Show surrounding conversation
          </button>
        )}
      </div>}
      <div className="conversation-body">
        {events.error && (
          <div className="error" role="alert">
            {events.error.message}
          </div>
        )}
        {events.data?.items.map((event) => (
          <article
            className={`message ${event.role} ${event.kind}`}
            key={event.id}
          >
            <div className="message-meta">
              <span className="message-avatar">
                {event.kind === "context" ? (
                  "C"
                ) : event.role === "user" ? (
                  "Y"
                ) : event.role === "assistant" ? (
                  "A"
                ) : (
                  <Terminal size={13} />
                )}
              </span>
              <strong>
                {event.kind === "context"
                  ? "Setup context"
                  : event.kind === "tool_call"
                    ? event.tool_name || "Tool call"
                    : event.kind === "tool_result"
                      ? "Tool result"
                      : event.role === "user"
                        ? "You"
                        : "Assistant"}
              </strong>
              {event.kind === "tool_call" && (
                <span className="action-tag" data-category={event.action_category}>
                  {ACTIONS.find(([v]) => v === event.action_category)?.[1] ||
                    event.action_category}
                </span>
              )}
              <time>{new Date(event.occurred_at).toLocaleString()}</time>
            </div>
            {event.kind === "tool_call" && event.hook_seen_at && <p className="hook-observation">{event.transcript_seen ? "Hook + transcript" : "Live hook · awaiting transcript"} · {event.hook_state === "unknown" ? "Outcome unknown" : event.hook_state === "requested" ? "Requested · outcome pending" : event.hook_state}</p>}
            {event.evaluations?.map((evaluation) => <SafetyVerdict key={evaluation.id} evaluation={evaluation} />)}
            {event.role === "tool" || event.kind === "context" ? (
              <details open={Boolean(search) || undefined}>
                <summary>
                  {event.kind === "tool_call"
                    ? "Recorded arguments"
                    : event.kind === "context"
                      ? "Injected setup context"
                      : "Recorded output"}
                </summary>
                <pre>
                  <Highlight
                    text={event.text}
                    q={search || initialQuery}
                    mode={mode}
                  />
                </pre>
              </details>
            ) : (
              <div className="message-text">
                <Highlight
                  text={event.text}
                  q={search || initialQuery}
                  mode={mode}
                />
              </div>
            )}
          </article>
        ))}
        {!events.data?.items.length && !events.error && (
          <div className="empty">
            <h3>
              {events.isPending
                ? "Loading conversation…"
                : "No matching records"}
            </h3>
            <p>
              Clear the search or action filter, or view the full session time
              range.
            </p>
          </div>
        )}
      </div>
      <div className="table-footer">
        <span>
          {events.data?.total ?? 0} records · action labels are text-based hints
        </span>
        <div>
          <button
            className="secondary"
            disabled={!(events.data?.offset ?? offset)}
            onClick={() => {
              setOffset(Math.max(0, (events.data?.offset ?? offset) - 100));
              setAnchor(null);
            }}
          >
            Previous
          </button>
          <span>
            {events.data?.total ? events.data.offset + 1 : 0}–
            {(events.data?.offset ?? 0) + (events.data?.items.length ?? 0)}
          </span>
          <button
            className="secondary"
            disabled={
              (events.data?.offset ?? offset) + 100 >= (events.data?.total ?? 0)
            }
            onClick={() => {
              setOffset((events.data?.offset ?? offset) + 100);
              setAnchor(null);
            }}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
