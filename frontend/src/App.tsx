import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Check,
  ChevronLeft,
  ChevronRight,
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
import { ConnectionDialog, Connections, Empty, Provider } from "./ui";
import { useSafetyNotifications } from "./useSafetyNotifications";
import { SafetyWorkspace } from "./SafetyView";
import { Timeline } from "./Timeline";
import { FIT, TimeRange, rangeQuery, type Range } from "./TimeRange";
import { ACTIONS, Conversation, Highlight } from "./Conversation";
import { DemoBanner } from "./DemoBanner";
import { DemoConnections } from "./DemoConnections";

type Page = "Overview" | "Safety" | "Explorer" | "Connections";
const routePage = (): Page => location.hash.startsWith("#safety") ? "Safety" : location.hash.startsWith("#explorer") ? "Explorer" : location.hash === "#connections" ? "Connections" : "Overview";
const number = (n = 0) => Intl.NumberFormat().format(n);

export default function App() {
  const notifications = useSafetyNotifications();
  const [chartReset, setChartReset] = useState(0);
  const [chartRange, setChartRange] = useState<Metrics["viewport"] | null>(null);
  const [sessionColorBy, setSessionColorBy] = useState("activity");
  const [chartKind, setChartKind] = useState<"sessions" | "messages" | "actions">("actions");
  const [page, setPage] = useState<Page>(routePage),
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
    [opened, setOpened] = useState<Session | null>(null),
    [detailKind, setDetailKind] = useState(""),
    [adding, setAdding] = useState(false),
    [notice, setNotice] = useState("");
  useEffect(() => {
    const close = (event: Event) => {
      const target = event.target as HTMLElement;
      document.querySelectorAll<HTMLDetailsElement>(".range-picker[open], .advanced-filters[open]").forEach(el => {
        if (event.type === "keydown" ? (event as KeyboardEvent).key === "Escape" : !el.contains(target)) el.open = false;
      });
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("focusin", close); document.removeEventListener("keydown", close); };
  }, []);
  useEffect(() => {
    const navigate = () => {
      const next = routePage();
      setPage(next);
      if (next === "Safety") {
        const args = new URLSearchParams(location.hash.split("?")[1]);
        if (args.get("message")) setNotice(args.get("message")!);
      }
      if (next === "Explorer") {
        const hash = location.hash, args = new URLSearchParams(hash.split("?")[1]), id = args.get("session");
        setOpened(null);
        setDetailKind(args.get("kind") === "tool_call" ? "tool_call" : args.get("kind") === "message" ? "message" : "");
        if (!id) return;
        setRange(FIT); setChartRange(null); setSearch(""); setQuery(""); setAction(""); setTool("");
        void Promise.all([api<{ session: Session & { connection_id: string } }>(`/sessions/${encodeURIComponent(id)}/events?limit=1`), api<Connection[]>("/connections")]).then(([data, sources]) => {
          if (location.hash !== hash) return;
          const source = sources.find(c => c.id === data.session.connection_id);
          setOpened({ ...data.session, messages: data.session.messages ?? 0, actions: data.session.actions ?? 0, provider: source?.provider ?? data.session.provider ?? "", connection_name: source?.name ?? data.session.connection_name ?? "", match: { kind: "tool_call", text: "", event_id: Number(args.get("event")) || null } });
        }).catch(() => { if (location.hash === hash) setNotice("Could not open this conversation. It may have been removed."); });
      }

    };
    const message = (event: MessageEvent) => {
      if (event.data?.type === "open-review") { location.hash = event.data.hash; navigate(); }
    };
    navigate();
    window.addEventListener("hashchange", navigate);
    navigator.serviceWorker?.addEventListener("message", message);
    return () => { window.removeEventListener("hashchange", navigate); navigator.serviceWorker?.removeEventListener("message", message); };
  }, []);
  const client = useQueryClient();
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: () => api<Connection[]>("/connections"),
  });
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api<{ status: string; demo?: boolean }>("/health"),
  });
  const demo = health.data?.demo === true;
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    setChartRange(null);
    setOffset(0);
    if (opened) closeSession();
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
    ...rangeQuery(range),
    q: query,
    search_mode: mode,
    search_scope: scope,
    action,
    tool,
    include_internal: String(internal),
    session_type: sessionType,
  });
  const visibleParams = new URLSearchParams(params);
  if (chartRange) { visibleParams.set("start", chartRange.start); visibleParams.set("end", chartRange.end); }
  const filterKey = visibleParams.toString();
  useEffect(() => setOffset(0), [filterKey]);
  const list = useQuery({
    queryKey: ["sessions", filterKey, sort, offset],
    queryFn: () =>
      api<{ total: number; items: Session[] }>(
        `/sessions?${visibleParams}&sort=${sort}&offset=${offset}`,
      ),
  });
  const metricParams = new URLSearchParams(params);
  const metricKey = metricParams.toString();
  const totalParams = new URLSearchParams(visibleParams);
  const metrics = useQuery({
    queryKey: ["metrics", totalParams.toString()],
    queryFn: () => api<Metrics>(`/metrics?${totalParams}`),
  });
  const sessions = list.data?.items ?? [],
    totals = metrics.data;
  const refresh = () => {
    void client.invalidateQueries();
  };
  function clearFilters() {
    setChartReset(n => n + 1);
    setConnection("");
    setSessionType("");
    setSort("recent");
    setOffset(0);
    closeSession();
    setRange(FIT);
    setChartRange(null);
    setSearch("");
    setQuery("");
    setAction("");
    setTool("");
    setInternal(false);
    setMode("words");
    setScope("messages");
  }
  function updateRoute(url: string, replace = false) {
    if (location.hash === url) return;
    history[replace ? "replaceState" : "pushState"](null, "", url);
  }
  function closeSession() {
    setOpened(null);
    if (location.hash.startsWith("#explorer")) updateRoute("#explorer", true);
  }
  function changePage(next: Page) {
    setPage(next);
    if (next === "Explorer") setOpened(null);
    updateRoute(next === "Overview" ? "#" : `#${next.toLowerCase()}`);
  }
  function openSession(session: Session, kind = "") {
    const args = new URLSearchParams({ session: session.id });
    if (kind) args.set("kind", kind);
    if (session.match?.event_id) args.set("event", String(session.match.event_id));
    updateRoute(`#explorer?${args}`);
    setPage("Explorer");
    setOpened(session);
    setDetailKind(kind);
  }
  const hasFilters = Boolean(
    connection ||
    range.start || chartRange ||
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
          relay{demo && <span className="version">DEMO</span>}
        </a>
        <nav aria-label="Main navigation">
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
              data-tour-nav={name.toLowerCase()}
              className={`nav-item ${page === name ? "active" : ""}`}
              aria-current={page === name ? "page" : undefined}
              onClick={() => changePage(name)}
            >
              <Icon size={18} />
              {name}
              {name === "Safety" && notifications.count > 0 && <span className="nav-count review-count" aria-label={`${notifications.count} pending reviews`}>{notifications.count}</span>}
              {name === "Connections" && (
                <span className="nav-count">
                  {connections.data?.length ?? 0}
                </span>
              )}
            </button>
          ))}
        </nav>
      </aside>
      <div className="main-shell">
        {demo && <DemoBanner onStart={() => { clearFilters(); changePage("Overview"); }} />}
        <main className={page === "Overview" ? "overview-page" : ""}>
          <div className="page-heading">
            <div>
              <h1>
                {page}
              </h1>
            </div>
            {page === "Connections" && !demo && <button className="primary" onClick={() => setAdding(true)}>
              <Plus size={16} />
              Add connection
            </button>}
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
            demo ? <DemoConnections items={connections.data ?? []} /> :
            <Connections
              items={connections.data ?? []}
              refresh={refresh}
              notify={setNotice}
              add={() => setAdding(true)}
              removed={(id) => {
                if (connection === id) setConnection("");
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
                    <TimeRange value={chartRange ? { ...chartRange, label: "Custom range" } : range} onChange={r => { setChartReset(n => n + 1); setChartRange(null); setRange(r); }} />
                    <details className="advanced-filters">
                      <summary>
                        More filters
                        {[
                          Boolean(tool),
                          Boolean(action),
                          Boolean(sessionType),
                          internal,
                          mode !== "words",
                          scope !== "messages",
                        ].filter(Boolean).length
                          ? ` (${[Boolean(tool), Boolean(action), Boolean(sessionType), internal, mode !== "words", scope !== "messages"].filter(Boolean).length})`
                          : ""}
                      </summary>
                      <div className="advanced-popover">
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
                        !hasFilters && sort === "recent"
                      }
                      onClick={clearFilters}
                    >
                      Clear all
                    </button>
                  </div>
                </section>
              </div>}
                {page === "Overview" && (
                  <>
                    <div className="stats" data-tour="overview">
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
                        <button
                          type="button"
                          aria-pressed={chartKind === label.toLowerCase()}
                          aria-label={`Show ${label.toLowerCase()} chart`}
                          onClick={() => setChartKind(label.toLowerCase() as typeof chartKind)}
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
                        </button>
                      ))}
                    </div>
                  </>
                )}
              {page !== "Safety" && <div hidden={page !== "Overview"}>
                <Timeline
                  key={`${metricKey}:${chartReset}`}
                  params={metricKey}
                  chartKind={chartKind}
                  onViewportChange={setChartRange}
                  onOpenSession={openSession}
                  colorBy={chartKind === "sessions" ? sessionColorBy : chartKind === "messages" && chartColorBy === "safety" ? "activity" : chartColorBy}
                  setColorBy={chartKind === "sessions" ? setSessionColorBy : setChartColorBy}
                />
              </div>}
              {page === "Safety" && <SafetyWorkspace demo={demo} notifications={notifications} connections={connections.data ?? []} refresh={refresh} notify={setNotice} />}
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
                          <th>SESSION</th>
                          {page === "Overview" && (
                            <th className="mobile-secondary">CONNECTION</th>
                          )}
                          <th className="number mobile-secondary">MESSAGES</th>
                          <th className="number">ACTIONS</th>
                          {page === "Overview" && <><th className="number">INPUT TOKENS</th><th className="number">OUTPUT TOKENS</th></>}
                          {page === "Overview" && (
                            <th className="mobile-secondary">LAST ACTIVITY</th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {sessions.map((session) => (
                          <tr
                            key={session.id}
                            className={opened?.id === session.id ? "selected" : ""}
                          >
                            <td>
                              <button
                                className="session-link"
                                data-tour-session={session.id}
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
                            {page === "Overview" && <>
                            <td className="number" title="Reported input tokens, including cached input, in the selected time range">{session.input_tokens == null ? "—" : `${session.tokens_partial ? "≥" : ""}${number(session.input_tokens)}`}</td>
                            <td className="number" title="Reported output tokens in the selected time range">{session.output_tokens == null ? "—" : `${session.tokens_partial ? "≥" : ""}${number(session.output_tokens)}`}</td>
                            </>}
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
                        ) : undefined
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
                        key={opened.id + filterKey + detailKind + (opened.match?.event_id ?? "")}
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

    </div>
  );
}
