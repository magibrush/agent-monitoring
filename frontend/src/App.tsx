import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Check,
  ChevronLeft,
  ChevronRight,
  Database,
  LayoutDashboard,
  MessageSquare,
  Plug,
  Plus,
  Search,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { api, type Connection, type Metrics, type Session } from "./api";
import { ConnectionDialog, Connections, Empty, Modal, Provider } from "./ui";
import { SafetyWorkspace } from "./SafetyView";
import { Timeline } from "./Timeline";
import { FIT, TimeRange, type Range } from "./TimeRange";
import { ACTIONS, Conversation, Highlight } from "./Conversation";

type Page = "Overview" | "Safety" | "Explorer" | "Connections";
const number = (n = 0) => Intl.NumberFormat().format(n);

export default function App() {
  const [page, setPage] = useState<Page>("Overview"),
    [chartColorBy, setChartColorBy] = useState("activity"),
    [sessionType, setSessionType] = useState(""),
    [connection, setConnection] = useState(""),
    [range, setRange] = useState<Range>(FIT),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [mode, setMode] = useState("words"),
    [scope, setScope] = useState("messages"),
    [action, setAction] = useState(""),
    [tool, setTool] = useState(""),
    [internal, setInternal] = useState(false),
    [sort, setSort] = useState("recent"),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<string[]>([]),
    [opened, setOpened] = useState<Session | null>(null),
    [detailKind, setDetailKind] = useState(""),
    [adding, setAdding] = useState(false),
    [notice, setNotice] = useState("");
  const client = useQueryClient();
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: () => api<Connection[]>("/connections"),
  });
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api<{ status: string }>("/health"),
  });
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    setOffset(0);
    setSelected([]);
    setOpened(null);
  }, [
    connection,
    range,
    query,
    mode,
    scope,
    action,
    tool,
    internal,
    sessionType,
  ]);
  const params = new URLSearchParams({
    connection,
    start: range.start,
    end: range.end,
    q: query,
    search_mode: mode,
    search_scope: scope,
    action,
    tool,
    include_internal: String(internal),
    session_type: sessionType,
  });
  const filterKey = params.toString();
  const list = useQuery({
    queryKey: ["sessions", filterKey, sort, offset],
    queryFn: () =>
      api<{ total: number; items: Session[] }>(
        `/sessions?${params}&sort=${sort}&offset=${offset}`,
      ),
  });
  const metricParams = new URLSearchParams(params);
  if (selected.length) metricParams.set("session_ids", selected.join(","));
  const metricKey = metricParams.toString();
  const metrics = useQuery({
    queryKey: ["metrics", metricKey],
    queryFn: () => api<Metrics>(`/metrics?${metricParams}`),
  });
  const sessions = list.data?.items ?? [],
    totals = metrics.data;
  const selectedVisible =
    sessions.length > 0 && sessions.every((s) => selected.includes(s.id));
  const refresh = () => {
    void client.invalidateQueries();
  };
  function clearFilters() {
    setConnection("");
    setSessionType("");
    setSort("recent");
    setOffset(0);
    setOpened(null);
    setRange(FIT);
    setSearch("");
    setQuery("");
    setAction("");
    setTool("");
    setInternal(false);
    setMode("words");
    setScope("messages");
    setSelected([]);
  }
  function changePage(next: Page) {
    setPage(next);
    setOpened(null);
  }
  function openSession(session: Session, kind = "") {
    setOpened(session);
    setDetailKind(kind);
  }
  const hasFilters = Boolean(
    connection ||
    range.start ||
    search ||
    action ||
    tool ||
    internal ||
    sessionType ||
    mode !== "words" ||
    scope !== "messages",
  );
  const error = connections.error || list.error || metrics.error;
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            changePage("Overview");
          }}
        >
          <span className="brand-symbol">
            <Activity size={21} />
          </span>
          relay<span className="version">LOCAL</span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">M</span>
          <div>
            My workspace<small>Personal environment</small>
          </div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {(
            [
              { name: "Overview", icon: LayoutDashboard },
              { name: "Safety", icon: ShieldCheck },
              { name: "Explorer", icon: MessageSquare },
              { name: "Connections", icon: Plug },
            ] as const
          ).map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={`nav-item ${page === name ? "active" : ""}`}
              onClick={() => changePage(name)}
            >
              <Icon size={18} />
              {name}
              {name === "Connections" && (
                <span className="nav-count">
                  {connections.data?.length ?? 0}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <Database size={17} />
            <div>
              Stored on this device<small>Judge context is sent to Anthropic.</small>
            </div>
          </div>
          <div className="profile">
            <span>ME</span>
            <div>
              Local workspace<small>Monitoring + safety evaluation</small>
            </div>
            <span className="status-dot" />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace
            <ChevronRight size={14} />
            <strong>{page}</strong>
          </div>
          <div className="topbar-right">
            <span className={`status-dot ${health.isError ? "red" : ""}`} />
            {health.isError
              ? "Backend offline"
              : health.isPending
                ? "Connecting…"
                : "Local backend connected"}
            <span className="top-avatar">M</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <h1>
                {page}
              </h1>
              {page === "Safety" && <p className="safety-subtitle">Review tool decisions and manage protection.</p>}
            </div>
            <button className="primary" onClick={() => setAdding(true)}>
              <Plus size={16} />
              Add connection
            </button>
          </div>
          {notice && (
            <div className="notice" role="status">
              <Check size={16} />
              {notice}
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error.message}
              <button onClick={refresh}>Retry</button>
            </div>
          )}
          {page === "Connections" ? (
            <Connections
              items={connections.data ?? []}
              refresh={refresh}
              notify={setNotice}
              add={() => setAdding(true)}
              removed={(id) => {
                if (connection === id) setConnection("");
                setSelected([]);
                setOpened(null);
                setOffset(0);
                client.removeQueries({ queryKey: ["events"] });
              }}
            />
          ) : (
            <>
              {page !== "Safety" && <div className="sticky-controls">
                <section className="filter-panel">
                  <div className="filter-row">
                    <label className="search global-search">
                      <Search size={16} />
                      <input
                        aria-label="Search conversations"
                        placeholder="Search messages or session titles…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                      {search && (
                        <button
                          aria-label="Clear search"
                          onClick={() => {
                            setSearch("");
                            setQuery("");
                          }}
                        >
                          <X size={14} />
                        </button>
                      )}
                    </label>

                    <select
                      aria-label="Filter connection"
                      value={connection}
                      onChange={(e) => setConnection(e.target.value)}
                    >
                      <option value="">All connections</option>
                      {connections.data?.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Session type"
                      value={sessionType}
                      onChange={(e) => setSessionType(e.target.value)}
                    >
                      <option value="">Type: All</option>
                      <option value="conversation">Type: Conversations</option>
                      <option value="subagent">Type: Subagents</option>
                    </select>
                    <select
                      aria-label="Action filter"
                      value={action}
                      onChange={(e) => setAction(e.target.value)}
                    >
                      {ACTIONS.map(([v, l]) => (
                        <option value={v} key={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                    <TimeRange value={range} onChange={setRange} />
                    <details className="advanced-filters">
                      <summary>
                        More filters
                        {[
                          Boolean(tool),
                          internal,
                          mode !== "words",
                          scope !== "messages",
                        ].filter(Boolean).length
                          ? ` (${[Boolean(tool), internal, mode !== "words", scope !== "messages"].filter(Boolean).length})`
                          : ""}
                      </summary>
                      <div className="advanced-popover">
                        {" "}
                        <label className="advanced-field">
                          <span>Search in</span>
                          <select
                            aria-label="Search scope"
                            value={scope}
                            onChange={(e) => setScope(e.target.value)}
                          >
                            <option value="messages">Messages + titles</option>
                            <option value="actions">
                              Tool arguments + output
                            </option>
                            <option value="all">
                              Messages + tools + titles
                            </option>
                            <option value="titles">Session titles only</option>
                          </select>
                        </label>
                        <label className="advanced-field">
                          <span>Match</span>
                          <select
                            aria-label="Search matching"
                            value={mode}
                            onChange={(e) => setMode(e.target.value)}
                          >
                            <option value="words">Whole word / phrase</option>
                            <option value="contains">Contains substring</option>
                          </select>
                        </label>
                        <label className="search tool-search">
                          <Terminal size={14} />
                          <input
                            aria-label="Filter tool name"
                            placeholder="Tool name contains…"
                            value={tool}
                            onChange={(e) => setTool(e.target.value)}
                          />
                        </label>
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={internal}
                            onChange={(e) => setInternal(e.target.checked)}
                          />
                          Include internal reviews
                        </label>
                      </div>
                    </details>
                    <button
                      className="clear-all"
                      disabled={
                        !hasFilters && !selected.length && sort === "recent"
                      }
                      onClick={clearFilters}
                    >
                      Clear all
                    </button>
                  </div>
                </section>
                {page === "Overview" && (
                  <>
                    <div className="selection-summary">
                      <span>
                        {selected.length
                          ? `${selected.length} session${selected.length === 1 ? "" : "s"} selected`
                          : `${list.data?.total ?? 0} matching sessions`}{" "}
                      </span>
                      {selected.length > 0 && (
                        <button
                          className="text-button"
                          onClick={() => setSelected([])}
                        >
                          Clear selection
                        </button>
                      )}
                    </div>
                    <div className="stats">
                      {[
                        {
                          label: "Sessions",
                          value: totals?.sessions,
                          note: "In the selected time range",
                        },
                        {
                          label: "Messages",
                          value: totals?.messages,
                          note: "User + assistant messages",
                        },
                        {
                          label: "Actions",
                          value: totals?.actions,
                          note:
                            action || tool
                              ? "Matching the action filters"
                              : "Tool-call records, not proven outcomes",
                        },
                      ].map(({ label, value, note }) => (
                        <section
                          className="stat"
                          key={label}
                          title={
                            label === "Messages"
                              ? `${number(totals?.questions)} user · ${number(totals?.answers)} assistant`
                              : note
                          }
                        >
                          <div className="stat-label">{label}</div>
                          <div className="stat-value">
                            {value === undefined
                              ? "—"
                              : typeof value === "number"
                                ? number(value)
                                : value}
                          </div>
                        </section>
                      ))}
                    </div>
                  </>
                )}
              </div>
              }
              {page === "Overview" && (
                <Timeline
                  key={metricKey}
                  params={metricKey}
                  colorBy={chartColorBy}
                  setColorBy={setChartColorBy}
                />
              )}
              {page === "Safety" && <SafetyWorkspace connections={connections.data ?? []} refresh={refresh} notify={setNotice} />}
              {page !== "Safety" && <div className={page === "Explorer" ? "explorer-layout" : ""}>
                <section className="panel session-panel">
                  <div className="panel-heading">
                    <div className="title-with-count">
                      <h2>
                        {page === "Overview" ? "Sessions" : "Matching sessions"}
                      </h2>
                      <span className="count">{list.data?.total ?? 0}</span>
                    </div>
                    <select
                      aria-label="Sort sessions"
                      value={sort}
                      onChange={(e) => {
                        setSort(e.target.value);
                        setOffset(0);
                      }}
                    >
                      <option value="recent">Sort: Most recent</option>
                      <option value="messages">Sort: Most messages</option>
                      <option value="actions">Sort: Most actions</option>
                      <option value="title">Sort: Title A–Z</option>
                    </select>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          {page === "Overview" && (
                            <th className="check-cell">
                              <input
                                type="checkbox"
                                aria-label="Select visible sessions"
                                checked={selectedVisible}
                                onChange={() =>
                                  setSelected((s) =>
                                    selectedVisible
                                      ? s.filter(
                                          (id) =>
                                            !sessions.some(
                                              (row) => row.id === id,
                                            ),
                                        )
                                      : [
                                          ...new Set([
                                            ...s,
                                            ...sessions.map((row) => row.id),
                                          ]),
                                        ],
                                  )
                                }
                              />
                            </th>
                          )}
                          <th>SESSION</th>
                          {page === "Overview" && (
                            <th className="mobile-secondary">CONNECTION</th>
                          )}
                          <th className="number mobile-secondary">MESSAGES</th>
                          <th className="number">ACTIONS</th>
                          {page === "Overview" && (
                            <th className="mobile-secondary">LAST ACTIVITY</th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {sessions.map((session) => (
                          <tr
                            key={session.id}
                            className={
                              (
                                page === "Overview"
                                  ? selected.includes(session.id)
                                  : opened?.id === session.id
                              )
                                ? "selected"
                                : ""
                            }
                          >
                            {page === "Overview" && (
                              <td className="check-cell">
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${session.title}`}
                                  checked={selected.includes(session.id)}
                                  onChange={() =>
                                    setSelected((s) =>
                                      s.includes(session.id)
                                        ? s.filter((id) => id !== session.id)
                                        : [...s, session.id],
                                    )
                                  }
                                />
                              </td>
                            )}
                            <td>
                              <button
                                className="session-link"
                                onClick={() => openSession(session)}
                              >
                                <Provider name={session.provider} />
                                <span>
                                  <strong>
                                    <Highlight
                                      text={session.title}
                                      q={query}
                                      mode={mode}
                                    />
                                  </strong>
                                  <small>
                                    <span
                                      className={
                                        page === "Overview"
                                          ? "session-connection-mobile"
                                          : "session-connection-inline"
                                      }
                                    >
                                      {session.connection_name}
                                    </span>
                                    {session.external_id.slice(0, 12)}
                                    <span className="source-tag">
                                      {session.session_type ===
                                      "internal_review"
                                        ? "Internal review"
                                        : session.session_type === "subagent"
                                          ? "Subagent"
                                          : "Conversation"}
                                    </span>
                                  </small>
                                </span>
                              </button>
                              {session.match && (
                                <button
                                  className="match-excerpt"
                                  onClick={() => openSession(session)}
                                >
                                  <span>
                                    {session.match.kind.replace("_", " ")} match
                                  </span>
                                  <Highlight
                                    text={session.match.text}
                                    q={query}
                                    mode={mode}
                                  />
                                </button>
                              )}
                            </td>
                            {page === "Overview" && (
                              <td className="connection-name mobile-secondary">
                                {session.connection_name}
                              </td>
                            )}
                            <td className="number mobile-secondary">
                              {number(session.messages)}
                            </td>
                            <td className="number">
                              <button
                                className="action-count"
                                aria-label={`Inspect actions in ${session.title}`}
                                onClick={() => {
                                  openSession(
                                    { ...session, match: null },
                                    "tool_call",
                                  );
                                }}
                              >
                                {number(session.actions)}
                              </button>
                            </td>
                            {page === "Overview" && (
                              <td className="time-cell mobile-secondary">
                                {new Date(session.updated_at).toLocaleString(
                                  undefined,
                                  {
                                    month: "short",
                                    day: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  },
                                )}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!sessions.length && (
                    <Empty
                      title={
                        list.isPending
                          ? "Loading sessions…"
                          : hasFilters
                            ? "No matching sessions"
                            : "Start with a connection"
                      }
                      text={
                        hasFilters
                          ? "Try another range, search scope, or action filter."
                          : "Connect Codex Desktop or Codex CLI to start observing conversations."
                      }
                      action={
                        hasFilters ? (
                          <button className="secondary" onClick={clearFilters}>
                            Reset filters
                          </button>
                        ) : (
                          <button
                            className="secondary"
                            onClick={() => setAdding(true)}
                          >
                            Add connection
                          </button>
                        )
                      }
                    />
                  )}
                  <div className="table-footer">
                    <span>
                      {page === "Overview"
                        ? ""
                        : "Click a session to inspect it alongside this list."}
                    </span>
                    <div>
                      <span>
                        {sessions.length ? offset + 1 : 0}–
                        {offset + sessions.length} of {list.data?.total ?? 0}
                      </span>
                      <button
                        className="icon-button"
                        aria-label="Previous sessions"
                        disabled={!offset}
                        onClick={() => setOffset(Math.max(0, offset - 50))}
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Next sessions"
                        disabled={offset + 50 >= (list.data?.total ?? 0)}
                        onClick={() => setOffset(offset + 50)}
                      >
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  </div>
                </section>
                {page === "Explorer" && (
                  <section className="panel explorer-detail">
                    {opened ? (
                      <Conversation
                        key={opened.id + filterKey + detailKind}
                        session={opened}
                        params={filterKey}
                        initialKind={detailKind}
                      />
                    ) : (
                      <Empty
                        title="Open a session to investigate"
                        text="Read messages, inspect tool arguments and outputs, and follow highlighted search matches without leaving this page."
                      />
                    )}
                  </section>
                )}
              </div>
              }
              <div className="workspace-footer">
                <span>
                  <span className="status-dot" />
                  {connections.data?.filter((c) => c.status === "watching")
                    .length ?? 0}{" "}
                  connections watching · refreshes every 2s
                </span>
                <span>Protection is configured per connection</span>
              </div>
            </>
          )}
        </main>
      </div>
      {adding && (
        <ConnectionDialog
          close={() => setAdding(false)}
          done={() => {
            setAdding(false);
            setPage("Connections");
            refresh();
            setNotice(
              "Connection added. Local conversations will sync automatically.",
            );
          }}
        />
      )}
      {opened && page === "Overview" && (
        <Modal wide close={() => setOpened(null)}>
          <button
            className="close-conversation icon-button"
            aria-label="Close conversation"
            onClick={() => setOpened(null)}
          >
            <X size={20} />
          </button>
          <Conversation
            key={opened.id + filterKey + detailKind}
            session={opened}
            params={filterKey}
            initialKind={detailKind}
          />
        </Modal>
      )}
    </div>
  );
}
