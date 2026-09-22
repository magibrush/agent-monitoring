import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Eye,
  ShieldCheck,
  Clock3,
  ArrowRight,
  Check,
  CircleHelp,
  Monitor,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  json,
  providerLabel,
  type Connection,
  type ProviderConfig,
} from "./api";

const sourceSummary = (provider: string, counts: Record<string, number>) =>
  provider === "claude_code"
    ? `${counts.claude_code ?? 0} Claude Code sessions (including ${counts.subagents ?? 0} subagents) · ${counts.unknown ?? 0} unsupported files`
    : `${counts.desktop ?? 0} Desktop · ${counts.cli ?? 0} CLI · ${counts.unknown ?? 0} unsupported files`;

const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not synced yet";
export function Provider({ name }: { name: string }) {
  return (
    <span
      className={`provider ${name}`}
      aria-label={providerLabel(name)}
      title={providerLabel(name)}
    >
      {name === "codex" ? (
        <Monitor size={19} aria-hidden="true" />
      ) : (
        <Terminal size={19} aria-hidden="true" />
      )}
      <span className="provider-product" aria-hidden="true">
        {name.startsWith("codex") ? "Codex" : name === "claude_code" ? "Claude" : name}
      </span>
      <span className="provider-caption" aria-hidden="true">
        {name === "codex" ? "Desktop" : name === "codex_cli" ? "CLI" : name === "claude_code" ? "CLI" : name}
      </span>
    </span>
  );
}
export function Empty({
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

export function Modal({
  children,
  close,
  wide = false,
}: {
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const root = ref.current!;
    const focusable = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, a[href], [tabindex="0"]',
        ),
      ).filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
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

export function ConnectionDialog({
  close,
  done,
}: {
  close: () => void;
  done: () => void;
}) {
  const [provider, setProvider] = useState("codex");
  const [customPath, setCustomPath] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  const [archives, setArchives] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checkedPath, setCheckedPath] = useState("");
  const defaults = useQuery({
    queryKey: ["config"],
    queryFn: () =>
      api<{
        providers: ProviderConfig[];
        sources: {
          path: string;
          archived: boolean;
          adapter: string;
          counts: Record<string, number>;
          error?: string;
        }[];
      }>("/config"),
  });
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: () => api<Connection[]>("/connections"),
  });
  const isClaude = provider === "claude_code";
  const sources = defaults.data?.sources.filter((s) => s.adapter === (isClaude ? "claude_code" : "codex")) ?? [];
  const normalPath =
    defaults.data?.providers.find((p) => p.id === provider)?.default_path ?? "";
  const archivePath = normalPath.replace(
    /sessions[\\/]?$/,
    "archived_sessions",
  );
  const path = customPath ?? (archives ? archivePath : normalPath);
  const name =
    customName.trim() ||
    `${providerLabel(provider)}${archives ? " · Archives" : ""}`;
  const duplicate = connections.data?.find(
    (c) =>
      c.provider === provider &&
      c.path?.replace(/\\/g, "/").toLowerCase() ===
        path.replace(/\\/g, "/").toLowerCase(),
  );
  useEffect(() => {
    const timer = setTimeout(() => setCheckedPath(path), 250);
    return () => clearTimeout(timer);
  }, [path]);
  const check = useQuery({
    queryKey: ["source-check", provider, checkedPath],
    queryFn: () =>
      api<{ matching_sessions: number; counts: Record<string, number> }>(
        "/connections/check",
        json("POST", { provider, path: checkedPath }),
      ),
    enabled: !!checkedPath && checkedPath === path,
    retry: false,
  });
  const checked = checkedPath === path ? check.data : undefined;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/connections", json("POST", { name, provider, path }));
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
          <h2 id="dialog-title">Connect an app</h2>
          <p>Import conversations from this computer.</p>
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
        <div className="app-choices" role="radiogroup" aria-label="App">
          {(
            defaults.data?.providers ?? [
              { id: "codex", label: "Codex Desktop" },
              { id: "codex_cli", label: "Codex CLI" },
              { id: "claude_code", label: "Claude Code" },
            ]
          ).map((p) => (
            <label
              key={p.id}
              className={`app-choice ${provider === p.id ? "chosen" : ""}`}
            >
              <input
                type="radio"
                name="integration"
                aria-label={p.label}
                value={p.id}
                checked={provider === p.id}
                onChange={() => {
                  setProvider(p.id);
                  setCustomPath(null);
                  setCustomName("");
                  setArchives(false);
                  setError("");
                }}
              />
              <Provider name={p.id} />
              <strong>{p.label}</strong>
            </label>
          ))}
        </div>
        <div className="connection-ready" role="status">
          {duplicate ? (
            <>
              <Check size={18} />
              <span>
                <strong>Already connected</strong>
                <small>{duplicate.name}</small>
              </span>
            </>
          ) : checked ? (
            <>
              <Check size={18} />
              <span>
                <strong>
                  {checked.matching_sessions} conversation
                  {checked.matching_sessions === 1 ? "" : "s"} found
                </strong>
                <small>
                  {archives
                    ? "Archived conversations"
                    : "On this computer · All projects"}
                </small>
              </span>
            </>
          ) : (
            <span>
              {check.isFetching || checkedPath !== path || defaults.isPending
                ? "Looking for conversations…"
                : "No readable source found. Choose a folder below."}
            </span>
          )}
        </div>
        <details className="connection-advanced">
          <summary>{isClaude ? "Another profile or folder" : "Another profile or archived conversations"}</summary>
          <p>
            Most people need one connection per app. Use this for a separate
            local profile or accessible WSL folder. {isClaude ? "The projects folder includes conversations and subagents across projects." : "You can also connect archived conversations."}
          </p>
          {!isClaude && <label className="archive-choice">
            <input
              type="checkbox"
              checked={archives}
              onChange={(e) => {
                setArchives(e.target.checked);
                setCustomPath(null);
              }}
            />{" "}
            Archived conversations (separate connection)
          </label>}
          {sources.length > 0 && (
            <label className="field">
              Detected folder
              <select
                aria-label="Detected source"
                value={
                  sources.some((s) => s.path === path)
                    ? path
                    : ""
                }
                onChange={(e) => {
                  setCustomPath(e.target.value);
                  setArchives(
                    sources.find(
                      (s) => s.path === e.target.value,
                    )?.archived ?? false,
                  );
                }}
              >
                <option value="">Custom folder</option>
                {sources.map((s) => (
                  <option key={s.path} value={s.path}>
                    {s.archived ? "Archive" : "Local profile"} · {s.path}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            Sessions directory
            <input
              value={path}
              onChange={(e) => {
                setCustomPath(e.target.value);
                if (/archived_sessions[\\/]?$/i.test(e.target.value))
                  setArchives(true);
                else if (/sessions[\\/]?$/i.test(e.target.value))
                  setArchives(false);
              }}
              placeholder={isClaude ? "Path to your Claude projects folder" : "Path to your Codex sessions folder"}
            />
          </label>
          <label className="field">
            Connection name
            <input
              maxLength={100}
              value={customName}
              placeholder={name}
              onChange={(e) => setCustomName(e.target.value)}
            />
          </label>
          <button
            className="secondary"
            type="button"
            disabled={!checkedPath || checkedPath !== path || check.isFetching}
            onClick={() => void check.refetch()}
          >
            Check source
          </button>
          {checked && (
            <p>
              {sourceSummary(provider, checked.counts)}
            </p>
          )}
        </details>
        {!duplicate && checked?.matching_sessions === 0 && (
          <p className="setup-note">
            No {providerLabel(provider)} conversations yet. Connect now to watch
            for new ones, or choose another folder above.
          </p>
        )}
        {(error || defaults.error || (checkedPath === path && check.error)) && (
          <div className="error" role="alert">
            {error || defaults.error?.message || check.error?.message}
          </div>
        )}
        <div className="modal-footer">
          <button className="secondary" type="button" onClick={close}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || !checked || !!duplicate}
          >
            {busy ? "Connecting…" : duplicate ? "Already connected" : "Connect"}
            <ArrowRight size={15} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function HookSetup({ connection, close, done }: { connection: Connection; close: () => void; done: (enabled: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [gate, setGate] = useState(connection.gate_enabled ?? false);
  const setup = useQuery({ queryKey: ["hook-setup", connection.id, gate], queryFn: () => api<{ path: string; config: unknown; instructions: string }>(`/connections/${connection.id}/hooks?gate_enabled=${gate}`), retry: false, refetchInterval: false });
  async function save(enabled: boolean) {
    setBusy(true); setError("");
    try { await api(`/connections/${connection.id}/hooks`, json("PATCH", { enabled, gate_enabled: enabled && gate })); done(enabled); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Modal close={() => { if (!busy) close(); }}>
    <div className="modal-heading"><div><h2 id="dialog-title">{connection.hooks_enabled ? "Manage live hooks" : "Set up live hooks"}</h2><p>{connection.name}</p></div><button className="icon-button" aria-label="Close hook setup" disabled={busy} onClick={close}><X size={20} /></button></div>
    <div className="hook-setup-body">
      <div className="hook-current"><span className={`badge ${connection.hooks_enabled ? "hook-installed" : ""}`}><span className={`status-dot ${connection.hooks_enabled ? "" : "gray"}`} />{connection.hooks_enabled ? "Installed" : "Not installed"}</span>{connection.hooks_enabled && <span>Saved: {connection.gate_enabled ? "Blocking evaluation" : "Observe only"}</span>}{connection.hooks_enabled && gate !== !!connection.gate_enabled && <span className="hook-unsaved" role="status">Unsaved changes</span>}</div>
      <fieldset className="hook-modes" disabled={busy}>
        <legend>Protection mode</legend>
        <label className={!gate ? "selected" : ""}><input type="radio" name="hook-mode" checked={!gate} onChange={() => setGate(false)} /><Eye size={20} aria-hidden="true" /><span><strong>Observe only</strong><small>Assess without blocking</small></span></label>
        <label className={gate ? "selected" : ""}><input type="radio" name="hook-mode" checked={gate} onChange={() => setGate(true)} /><ShieldCheck size={20} aria-hidden="true" /><span><strong>Block risky actions</strong><small>Judge checks before execution</small></span></label>
      </fieldset>
      {gate && <div className="hook-facts"><span><Clock3 size={14} />60s decision window</span><span>Timeouts block</span><span>Partial coverage</span></div>}
      <div className="hook-next-steps"><strong>After saving</strong><ol><li><span>1</span>Restart agent sessions</li>{connection.provider.startsWith("codex") && <li><span>2</span>Trust the handler in <code>/hooks</code></li>}</ol></div>
      <details className="hook-details"><summary>Behavior &amp; coverage</summary>
        <dl className="hook-fact-grid">
          <div><dt>Review requests</dt><dd>Approve or deny in Safety</dd></div>
          <div><dt>Timeout or judge unavailable</dt><dd>Blocked in blocking mode</dd></div>
          <div><dt>Coverage</dt><dd>Hooked tools only; subprocesses and hosted tools may bypass checks</dd></div>
          <div><dt>Verify blocking</dt><dd>Check a request's Relay response in Safety; installation alone is not proof</dd></div>
          <div><dt>Settings</dt><dd>Backed up; other hooks preserved</dd></div>
          <div><dt>Offline</dt><dd>Notifications queued locally</dd></div>
          <div><dt>Pause collection</dt><dd>Hooks and blocking stay on</dd></div>
        </dl>
      </details>
      {setup.data && <details className="hook-details hook-configuration"><summary>Configuration</summary><div className="connection-detail"><span>Settings file</span><code>{setup.data.path}</code></div><pre className="hook-config">{JSON.stringify(setup.data.config, null, 2)}</pre></details>}
      {connection.hooks_enabled && <div className="hook-remove"><small>Stop observing and blocking. Restart sessions after removal.</small><button className="secondary danger" disabled={busy} onClick={() => save(false)}>Remove hooks</button></div>}
      {(error || setup.error) && <div className="error" role="alert">{error || (setup.error as Error).message}</div>}
    </div><div className="modal-footer hook-setup-footer"><button className="secondary" disabled={busy} onClick={close}>Close</button><button className="primary" disabled={busy || !setup.data || (connection.hooks_enabled && gate === !!connection.gate_enabled)} onClick={() => save(true)}>{busy ? "Updating..." : connection.hooks_enabled ? "Save changes" : "Enable live hooks"}</button></div>
  </Modal>;
}

export function Connections({
  items,
  refresh,
  notify,
  add,
  removed,
}: {
  items: Connection[];
  refresh: () => void;
  notify: (s: string) => void;
  add: () => void;
  removed: (id: string) => void;
}) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [deleteBusy, setDeleteBusy] = useState(false);
  function markBusy(key: string, value: boolean) {
    setBusy(previous => ({ ...previous, [key]: value }));
  }
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [hookConnection, setHookConnection] = useState<Connection | null>(null);
  async function removeConnection() {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await api(`/connections/${deleting.id}`, { method: "DELETE" });
      removed(deleting.id);
      setDeleting(null);
      notify(
        "Connection and imported records deleted. Original conversations are unchanged.",
      );
      refresh();
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  }
  async function run(c: Connection, action: "sync" | "toggle" | "check") {
    const key = `${c.id}:${action}`;
    markBusy(key, true);
    setError("");
    try {
      if (action === "check") {
        const result = await api<{
          matching_sessions: number;
          counts: Record<string, number>;
        }>(
          "/connections/check",
          json("POST", { provider: c.provider, path: c.path }),
        );
        setDiagnostics((previous) => ({
          ...previous,
          [c.id]: `${result.matching_sessions} matching sessions. ${sourceSummary(c.provider, result.counts)}`,
        }));
      } else if (action === "toggle")
        await api(
          `/connections/${c.id}`,
          json("PATCH", { enabled: !c.enabled }),
        );
      else {
        const result = await api<Connection>(`/connections/${c.id}/sync`, {
          method: "POST",
        });
        if (result.error) throw new Error(result.error);
        notify(result.status === "syncing" ? `${providerLabel(c.provider)} sync is already running.` : result.status === "paused" ? "Connection paused." : `${providerLabel(c.provider)} sync completed.`);
      }
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      markBusy(key, false);
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
            <div className="connection-stats"><div><span>Sessions imported</span><strong>{c.session_count ?? 0}</strong></div><div><span>Last sync</span><strong>{date(c.last_sync)}</strong></div></div>
            {c.session_count === 0 && c.last_sync && (
              <div className="info-box">
                No conversations imported yet. Check the source to see whether
                this folder contains {providerLabel(c.provider)} sessions.
              </div>
            )}
            {diagnostics[c.id] && <p role="status">{diagnostics[c.id]}</p>}
            <div className="connection-source-path"><span>Source folder</span><code>{c.path}</code></div>
            {c.error && <div className="error">{c.error}</div>}
            <div className="connection-hooks">
              <div className="connection-hooks-heading"><strong><ShieldCheck size={16} />Live hooks</strong><span className="badge">{c.hooks_enabled ? "Installed" : "Not installed"}</span></div>
              <div className="connection-hook-mode">{c.hooks_enabled ? (c.gate_enabled ? "Blocking evaluation" : "Observe only") : "Connect to assess tool requests"}</div>
              {c.hooks_enabled && <small>{!c.enabled ? "Collection paused; hooks remain installed" : c.hook_last_seen ? `Last received ${date(c.hook_last_seen)}` : "Waiting for first hook; restart agent sessions"}</small>}
              {c.hook_error && <p className="error">{c.hook_error}</p>}
              <button className="secondary" onClick={() => setHookConnection(c)}>{c.hooks_enabled ? "Manage hooks" : "Set up live hooks"}</button>
            </div>
            <div className="connection-actions">
              <button
                className="secondary"
                disabled={busy[`${c.id}:check`]}
                onClick={() => run(c, "check")}
              >
                Check source
              </button>
              <button
                className="secondary"
                disabled={busy[`${c.id}:sync`] || !c.enabled}
                onClick={() => run(c, "sync")}
              >
                <RefreshCw size={15} />
                {busy[`${c.id}:sync`] ? "Syncing…" : "Sync now"}
              </button>
              <button
                className="secondary"
                disabled={busy[`${c.id}:toggle`]}
                onClick={() => run(c, "toggle")}
              >
                {c.enabled ? <Pause size={15} /> : <Play size={15} />}
                {c.enabled ? "Pause" : "Resume"}
              </button>
              <button
                className="secondary delete-connection"
                disabled={deleteBusy}
                onClick={() => {
                  setDeleteError("");
                  setDeleting(c);
                }}
              >
                <Trash2 size={15} aria-hidden="true" /> Delete
              </button>
            </div>
          </section>
        ))}
        <button className="add-card" onClick={add}>
          <span>
            <Plus size={24} />
          </span>
          <strong>Add a connection</strong>
          <small>Desktop, CLI, or another local profile</small>
        </button>
      </div>
      {hookConnection && <HookSetup connection={hookConnection} close={() => setHookConnection(null)} done={(enabled) => { refresh(); setHookConnection(null); notify(enabled ? "Hooks saved. Restart agent sessions; review Codex hooks in /hooks." : "Relay hooks removed. Restart agent sessions to finish removal."); }} />}
      {deleting && (
        <Modal
          close={() => {
            if (!deleteBusy) setDeleting(null);
          }}
        >
          <div className="modal-heading">
            <div>
              <h2 id="dialog-title">Delete connection?</h2>
              <p className="delete-connection-name">{deleting.name}</p>
            </div>
          </div>
          <div className="delete-connection-body">
            <p>
              This removes this connection and all its imported conversations,
              messages, tool records, and sync checkpoints from Relay.
            </p>
            <p>
              <strong>
                Your original conversations and transcript files will not
                be deleted.
              </strong>{" "}
              Other connections are unaffected.
            </p>
            <p>
              You can add this source again to re-import its available history.
            </p>
            {deleteError && (
              <div className="error" role="alert">
                {deleteError}
              </div>
            )}
          </div>
          <div className="modal-footer delete-dialog-footer">
            <button
              className="secondary"
              disabled={deleteBusy}
              onClick={() => setDeleting(null)}
            >
              Cancel
            </button>
            <button
              className="danger-button"
              disabled={deleteBusy}
              onClick={() => void removeConnection()}
            >
              {deleteBusy ? "Deleting…" : "Delete connection"}
            </button>
          </div>
        </Modal>
      )}
      <div className="capabilities panel">
        <h2>What’s available in this version</h2>
        <div>
          <Check size={17} />
          <p>
            <strong>Codex Desktop, Codex CLI, and Claude Code</strong> — local chat messages
            and tool calls where recorded, refreshed automatically.
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
