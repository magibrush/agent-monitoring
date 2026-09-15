import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowDownUp,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleHelp,
  Database,
  LayoutDashboard,
  MessageSquare,
  Pause,
  Play,
  Plug,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Terminal,
  X,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  api,
  json,
  type ChatEvent,
  type Connection,
  type Metrics,
  type Session,
} from "./api";

type Page = "Overview" | "Sessions" | "Connections";
const format = (n = 0) => Intl.NumberFormat().format(n);
const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not synced yet";
function Provider({ name }: { name: string }) {
  return (
    <span className={`provider ${name}`} aria-label={name}>
      <Terminal size={16} />
    </span>
  );
}
function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Activity size={24} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("Overview");
  const [provider, setProvider] = useState("");
  const [connection, setConnection] = useState("");
  const [days, setDays] = useState("7");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [opened, setOpened] = useState<Session | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
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
  }, [provider, connection, days, query]);
  const params = new URLSearchParams({ provider, connection, days, q: query });
  const sessionQuery = useQuery({
    queryKey: ["sessions", params.toString(), sort, offset],
    queryFn: () =>
      api<{ total: number; items: Session[] }>(
        `/sessions?${params}&sort=${sort}&offset=${offset}`,
      ),
  });
  const metricParams = new URLSearchParams(params);
  if (selected.length) metricParams.set("session_ids", selected.join(","));
  const metrics = useQuery({
    queryKey: ["metrics", metricParams.toString()],
    queryFn: () => api<Metrics>(`/metrics?${metricParams}`),
  });
  const sessions = sessionQuery.data?.items ?? [];
  const totals = metrics.data;
  const watching =
    connections.data?.filter((c) => c.enabled && c.status === "watching")
      .length ?? 0;
  const refresh = () => {
    void client.invalidateQueries();
  };
  const toggle = (id: string) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s, id],
    );
  const visibleSelected =
    sessions.length > 0 && sessions.every((s) => selected.includes(s.id));
  const error = connections.error || sessionQuery.error || metrics.error;
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("Overview");
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
          <ChevronsUpDown size={14} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {(
            [
              { name: "Overview", icon: LayoutDashboard },
              { name: "Sessions", icon: MessageSquare },
              { name: "Connections", icon: Plug },
            ] as const
          ).map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={page === name ? "nav-item active" : "nav-item"}
              onClick={() => setPage(name)}
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
              Stored on this device<small>Your conversations stay local.</small>
            </div>
          </div>
          <a href="http://127.0.0.1:8000/docs" target="_blank" rel="noreferrer">
            <CircleHelp size={16} />
            API reference <ArrowRight size={14} />
          </a>
          <div className="profile">
            <span>ME</span>
            <div>
              Local workspace<small>Observation mode</small>
            </div>
            <span className="status-dot" />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />
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
              <div className="eyebrow">AGENT OBSERVABILITY</div>
              <h1>
                {page === "Overview"
                  ? "Your agents, in focus."
                  : page === "Sessions"
                    ? "Every conversation."
                    : "Connect your workspace."}
              </h1>
              <p>
                {page === "Overview"
                  ? "A clear view of your conversations and the work behind them."
                  : page === "Sessions"
                    ? "Explore messages and recorded tool activity across your sessions."
                    : "Bring your desktop agents into one local view."}
              </p>
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
            />
          ) : (
            <>
              <div className="filterbar">
                <div className="filters">
                  <select
                    aria-label="Filter provider"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                  >
                    <option value="">All providers</option>
                    <option value="codex">Codex Desktop</option>
                  </select>
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
                  <span className="filter-divider" />
                  <span className="selection-label">
                    {selected.length
                      ? `${selected.length} session${selected.length === 1 ? "" : "s"} selected`
                      : "All matching sessions"}
                    {selected.length > 0 && (
                      <button onClick={() => setSelected([])}>Clear</button>
                    )}
                  </span>
                </div>
                <select
                  aria-label="Time range"
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                >
                  <option value="1">Last 24 hours</option>
                  <option value="7">Last 7 days</option>
                  <option value="30">Last 30 days</option>
                  <option value="0">All time</option>
                </select>
              </div>
              {page === "Overview" && (
                <>
                  <div className="stats">
                    {[
                      {
                        label: "Sessions with activity",
                        value: totals?.sessions,
                        icon: Radio,
                        note: selected.length
                          ? "Across selected sessions"
                          : "Across matching sessions",
                      },
                      {
                        label: "Messages",
                        value: totals?.messages,
                        icon: MessageSquare,
                        note: "User + assistant messages",
                      },
                      {
                        label: "Questions / answers",
                        value: totals
                          ? `${format(totals.questions)} / ${format(totals.answers)}`
                          : undefined,
                        icon: ArrowDownUp,
                        note: "Prompts / assistant messages",
                      },
                      {
                        label: "Recorded actions",
                        value: totals?.actions,
                        icon: Terminal,
                        note: "Tool calls in source transcripts",
                      },
                    ].map(({ label, value, icon: Icon, note }) => (
                      <section className="stat" key={label}>
                        <div className="stat-label">
                          {label}
                          <Icon size={16} />
                        </div>
                        <div className="stat-value">
                          {value === undefined
                            ? "—"
                            : typeof value === "number"
                              ? format(value)
                              : value}
                        </div>
                        <div className="stat-note">{note}</div>
                      </section>
                    ))}
                  </div>
                  <div className="chart-grid">
                    <section className="panel activity-panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Conversation activity</h2>
                          <p>Messages over time · UTC</p>
                        </div>
                        <div className="legend">
                          <span>
                            <i className="blue" />
                            User
                          </span>
                          <span>
                            <i className="teal" />
                            Assistant
                          </span>
                        </div>
                      </div>
                      {totals && totals.messages > 0 ? (
                        <ActivityChart metrics={totals} days={Number(days)} />
                      ) : (
                        <Empty
                          title={
                            metrics.isPending
                              ? "Loading activity…"
                              : "A quiet workspace, for now"
                          }
                          text="Connect Codex Desktop to see your activity here."
                        />
                      )}
                    </section>
                    <section className="panel tools-panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Tool activity</h2>
                          <p>Most frequently recorded actions</p>
                        </div>
                        <Terminal size={17} />
                      </div>
                      {totals?.tools.length ? (
                        <div className="tool-list">
                          {totals.tools.map((tool, index) => (
                            <div className="tool-row" key={tool.name}>
                              <div>
                                <span className="tool-rank">0{index + 1}</span>
                                <span title={tool.name}>{tool.name}</span>
                                <strong>{format(tool.count)}</strong>
                              </div>
                              <div className="tool-track">
                                <div
                                  style={{
                                    width: `${(tool.count / totals.tools[0].count) * 100}%`,
                                  }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <Empty
                          title="No recorded tool calls"
                          text="Tool details appear when they are available in the source."
                        />
                      )}
                      <div className="panel-foot">
                        <span className="status-dot gray" />
                        Observation only · actions are not blocked
                      </div>
                    </section>
                  </div>
                </>
              )}
              <section className="panel session-panel">
                <div className="panel-heading">
                  <div className="title-with-count">
                    <h2>
                      {page === "Overview"
                        ? "Sessions"
                        : "Conversation explorer"}
                    </h2>
                    <span className="count">
                      {sessionQuery.data?.total ?? 0}
                    </span>
                  </div>
                  <div className="table-controls">
                    <label className="search">
                      <Search size={16} />
                      <input
                        placeholder="Search conversations…"
                        aria-label="Search conversations"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                      {search && (
                        <button
                          aria-label="Clear search"
                          onClick={() => setSearch("")}
                        >
                          <X size={14} />
                        </button>
                      )}
                    </label>
                    <select
                      aria-label="Sort sessions"
                      value={sort}
                      onChange={(e) => {
                        setSort(e.target.value);
                        setOffset(0);
                      }}
                    >
                      <option value="recent">Most recent</option>
                      <option value="messages">Most messages</option>
                      <option value="actions">Most actions</option>
                      <option value="title">Title A–Z</option>
                    </select>
                  </div>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th className="check-cell">
                          <input
                            type="checkbox"
                            aria-label="Select visible sessions"
                            checked={visibleSelected}
                            onChange={() =>
                              setSelected((s) =>
                                visibleSelected
                                  ? s.filter(
                                      (id) =>
                                        !sessions.some((row) => row.id === id),
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
                        <th>SESSION</th>
                        <th>CONNECTION</th>
                        <th className="number">MESSAGES</th>
                        <th className="number">ACTIONS</th>
                        <th>LAST ACTIVITY</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map((session) => (
                        <tr
                          key={session.id}
                          className={
                            selected.includes(session.id) ? "selected" : ""
                          }
                        >
                          <td className="check-cell">
                            <input
                              type="checkbox"
                              aria-label={`Select ${session.title}`}
                              checked={selected.includes(session.id)}
                              onChange={() => toggle(session.id)}
                            />
                          </td>
                          <td>
                            <button
                              className="session-link"
                              onClick={() => setOpened(session)}
                            >
                              <Provider name={session.provider} />
                              <span>
                                <strong>{session.title}</strong>
                                <small>
                                  {session.external_id.slice(0, 18)}
                                  <span className="source-tag">
                                    Local transcript
                                  </span>
                                </small>
                              </span>
                            </button>
                          </td>
                          <td>
                            <span className="connection-name">
                              {session.connection_name}
                            </span>
                          </td>
                          <td className="number">{format(session.messages)}</td>
                          <td className="number">{format(session.actions)}</td>
                          <td className="time-cell">
                            {date(session.updated_at)}
                          </td>
                          <td>
                            <button
                              className="icon-button"
                              aria-label={`Open ${session.title}`}
                              onClick={() => setOpened(session)}
                            >
                              <ChevronRight size={16} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {sessions.length === 0 && (
                  <Empty
                    title={
                      sessionQuery.isPending
                        ? "Loading sessions…"
                        : query || provider || connection
                          ? "No matching sessions"
                          : "Start with a connection"
                    }
                    text={
                      query || provider || connection
                        ? "Try another search, provider, or time range."
                        : "Connect Codex Desktop. Each conversation becomes a separate session."
                    }
                    action={
                      !query && !provider && !connection ? (
                        <button
                          className="secondary"
                          onClick={() => setAdding(true)}
                        >
                          <Plus size={15} />
                          Add your first connection
                        </button>
                      ) : undefined
                    }
                  />
                )}
                <div className="table-footer">
                  <span>
                    {selected.length
                      ? `${selected.length} selected · charts show their combined activity`
                      : "Select sessions to compare their combined activity"}
                  </span>
                  <div>
                    {selected.length > 0 && (
                      <button
                        className="secondary"
                        onClick={() => setSelected([])}
                      >
                        Clear selection
                      </button>
                    )}
                    <span>
                      {sessions.length ? offset + 1 : 0}–
                      {offset + sessions.length} of{" "}
                      {sessionQuery.data?.total ?? 0}
                    </span>
                    <button
                      className="icon-button"
                      aria-label="Previous sessions"
                      disabled={offset === 0}
                      onClick={() => setOffset((o) => Math.max(0, o - 50))}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Next sessions"
                      disabled={offset + 50 >= (sessionQuery.data?.total ?? 0)}
                      onClick={() => setOffset((o) => o + 50)}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              </section>
              <div className="workspace-footer">
                <span>
                  <span className="status-dot" />
                  {watching} {watching === 1 ? "connection" : "connections"}{" "}
                  watching · refreshes every 4s
                </span>
                <span>
                  Local storage <span className="footer-separator">/</span>{" "}
                  Relay v0.1
                </span>
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
              "Connection added. Its local conversations will sync automatically.",
            );
          }}
        />
      )}
      {opened && (
        <Conversation session={opened} close={() => setOpened(null)} />
      )}
    </div>
  );
}

function ActivityChart({ metrics, days }: { metrics: Metrics; days: number }) {
  const messageRows = metrics.daily.filter((d) => d.kind === "message");
  const start = days
    ? new Date(Date.now() - days * 86400000)
    : new Date(messageRows.map((d) => d.day).sort()[0] ?? Date.now());
  start.setUTCHours(0, 0, 0, 0);
  const rows: { day: string; User: number; Assistant: number }[] = [];
  for (let t = start.getTime(); t <= Date.now(); t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    rows.push({ day, User: 0, Assistant: 0 });
  }
  const byDay = new Map(rows.map((r) => [r.day, r]));
  for (const entry of messageRows) {
    const row = byDay.get(entry.day);
    if (row) row[entry.role === "user" ? "User" : "Assistant"] += entry.count;
  }
  return (
    <div
      className="chart"
      role="img"
      aria-label={`Message activity: ${metrics.questions} user prompts and ${metrics.answers} assistant messages. Daily counts available in chart tooltips.`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={rows}
          margin={{ top: 18, right: 16, left: -24, bottom: 4 }}
        >
          <defs>
            <linearGradient id="userFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#516bcc" stopOpacity={0.14} />
              <stop offset="100%" stopColor="#516bcc" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 4"
            vertical={false}
            stroke="#e8ebef"
          />
          <XAxis
            dataKey="day"
            tickFormatter={(d) =>
              new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              })
            }
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#8a929f", fontSize: 11 }}
            minTickGap={35}
          />
          <YAxis
            allowDecimals={false}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#8a929f", fontSize: 11 }}
          />
          <Tooltip
            contentStyle={{
              border: "1px solid #e5e8ec",
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Area
            type="monotone"
            dataKey="User"
            stroke="#516bcc"
            strokeWidth={2}
            fill="url(#userFill)"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="Assistant"
            stroke="#4f9b8c"
            strokeWidth={2}
            fill="transparent"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function Modal({
  children,
  close,
  wide = false,
}: {
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const root = ref.current!;
    const focusable = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, select, a[href], [tabindex="0"]',
        ),
      );
    focusable()[0]?.focus();
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const items = focusable();
        const first = items[0],
          last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", listener);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", listener);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        className={wide ? "modal conversation-modal" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        {children}
      </div>
    </div>
  );
}

function ConnectionDialog({
  close,
  done,
}: {
  close: () => void;
  done: () => void;
}) {
  const provider = "codex";
  const [name, setName] = useState("Codex · My desktop");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const defaults = useQuery({
    queryKey: ["config"],
    queryFn: () => api<{ codex_path: string }>("/config"),
  });
  useEffect(() => {
    if (defaults.data)
      setPath((current) => current || defaults.data.codex_path);
  }, [defaults.data]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        "/connections",
        json("POST", {
          name,
          provider,
          path,
        }),
      );
      done();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal close={close}>
      <div className="modal-heading">
        <div>
          <h2 id="dialog-title">Add a connection</h2>
          <p>Keep each source organized in its own connection.</p>
        </div>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={close}
        >
          <X size={20} />
        </button>
      </div>
      <form onSubmit={submit}>
        <div className="connection-source">
          <Provider name="codex" />
          <div>
            <strong>Codex Desktop</strong>
            <p>Local transcript watcher</p>
          </div>
        </div>
        <label className="field">
          Connection name
          <input
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="field">
          Sessions directory
          <input
            required
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="C:\Users\you\.codex\sessions"
          />
        </label>
        <div className="info-box">
          Reads local transcripts every 3 seconds. Only sessions identified as
          Codex Desktop are included. This adapter depends on the local
          transcript format; cloud-only chats are unavailable.
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-footer">
          <button className="secondary" type="button" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            {busy ? "Adding…" : "Add connection"}
            <ArrowRight size={15} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Connections({
  items,
  refresh,
  notify,
  add,
}: {
  items: Connection[];
  refresh: () => void;
  notify: (s: string) => void;
  add: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function run(c: Connection, action: "sync" | "toggle") {
    setBusy(c.id);
    setError("");
    try {
      if (action === "toggle")
        await api(
          `/connections/${c.id}`,
          json("PATCH", { enabled: !c.enabled }),
        );
      else {
        const result = await api<Connection>(`/connections/${c.id}/sync`, {
          method: "POST",
        });
        if (result.error) throw new Error(result.error);
        notify("Codex sync completed.");
      }
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="connection-grid">
        {items.map((c) => (
          <section className="panel connection-card" key={c.id}>
            <div className="connection-card-top">
              <Provider name={c.provider} />
              <span className={`badge ${c.status === "error" ? "bad" : ""}`}>
                <span
                  className={`status-dot ${c.status === "watching" ? "" : "gray"}`}
                />
                {c.status}
              </span>
            </div>
            <h2>{c.name}</h2>
            <p>Codex Desktop · Local transcript watcher</p>
            <div className="connection-detail">
              <span>SOURCE</span>
              <code>{c.path}</code>
            </div>
            <div className="connection-detail">
              <span>LAST SUCCESSFUL SYNC</span>
              <strong>{date(c.last_sync)}</strong>
            </div>
            {c.error && <div className="error">{c.error}</div>}
            <div className="connection-actions">
              <button
                className="secondary"
                disabled={busy === c.id || !c.enabled}
                onClick={() => run(c, "sync")}
              >
                <RefreshCw size={15} />
                {busy === c.id ? "Working…" : "Sync now"}
              </button>
              <button
                className="secondary"
                disabled={busy === c.id}
                onClick={() => run(c, "toggle")}
              >
                {c.enabled ? <Pause size={15} /> : <Play size={15} />}
                {c.enabled ? "Pause" : "Resume"}
              </button>
            </div>
          </section>
        ))}
        <button className="add-card" onClick={add}>
          <span>
            <Plus size={24} />
          </span>
          <strong>Add a connection</strong>
          <small>Another desktop or local profile</small>
        </button>
      </div>
      <div className="capabilities panel">
        <h2>What’s available in this version</h2>
        <div>
          <Check size={17} />
          <p>
            <strong>Codex Desktop</strong> — local chat messages and tool calls
            where recorded, refreshed automatically.
          </p>
        </div>
        <div>
          <CircleHelp size={17} />
          <p>
            Images and binary attachments are not rendered. Counts reflect
            observed records; missing source events cannot be inferred.
          </p>
        </div>
      </div>
    </>
  );
}

function Conversation({
  session,
  close,
}: {
  session: Session;
  close: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);
  const params = new URLSearchParams({
    offset: String(offset),
    kind,
    q: query,
  });
  const events = useQuery({
    queryKey: ["events", session.id, params.toString()],
    queryFn: () =>
      api<{ total: number; items: ChatEvent[] }>(
        `/sessions/${session.id}/events?${params}`,
      ),
  });
  return (
    <Modal close={close} wide>
      <div className="modal-heading">
        <Provider name={session.provider} />
        <div className="conversation-title">
          <h2 id="dialog-title">{session.title}</h2>
          <p>{session.connection_name} · Local transcript</p>
        </div>
        <button
          className="icon-button"
          aria-label="Close conversation"
          onClick={close}
        >
          <X size={20} />
        </button>
      </div>
      <div className="conversation-toolbar">
        <label className="search">
          <Search size={15} />
          <input
            aria-label="Search this conversation"
            placeholder="Find in conversation…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          aria-label="Filter event type"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All events</option>
          <option value="message">Messages</option>
          <option value="tool_call">Tool calls</option>
          <option value="tool_result">Tool results</option>
        </select>
      </div>
      <div className="conversation-body">
        {events.error && (
          <div className="error" role="alert">
            {events.error.message}
          </div>
        )}
        {events.data?.items.map((event) => (
          <article className={`message ${event.role}`} key={event.id}>
            <div className="message-meta">
              <span className="message-avatar">
                {event.role === "user" ? (
                  "Y"
                ) : event.role === "assistant" ? (
                  "A"
                ) : (
                  <Terminal size={13} />
                )}
              </span>
              <strong>
                {event.kind === "tool_call"
                  ? (event.tool_name ?? "Tool call")
                  : event.kind === "tool_result"
                    ? "Tool result"
                    : event.role === "user"
                      ? "You"
                      : "Assistant"}
              </strong>
              <time>{date(event.occurred_at)}</time>
            </div>
            {event.role === "tool" ? (
              <details>
                <summary>
                  {event.kind === "tool_call"
                    ? "View recorded arguments"
                    : "View tool output"}
                </summary>
                <pre>{event.text}</pre>
              </details>
            ) : (
              <div className="message-text">{event.text}</div>
            )}
          </article>
        ))}
        {!events.data?.items.length && (
          <Empty
            title={
              events.isPending ? "Loading conversation…" : "No events found"
            }
            text="Messages and recorded tool activity will appear here."
          />
        )}
      </div>
      <div className="table-footer">
        <span>{events.data?.total ?? 0} events · full session history</span>
        <div>
          <button
            className="secondary"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - 100))}
          >
            Previous
          </button>
          <span>
            {offset + 1}–{offset + (events.data?.items.length ?? 0)}
          </span>
          <button
            className="secondary"
            disabled={offset + 100 >= (events.data?.total ?? 0)}
            onClick={() => setOffset((o) => o + 100)}
          >
            Next
          </button>
        </div>
      </div>
    </Modal>
  );
}
