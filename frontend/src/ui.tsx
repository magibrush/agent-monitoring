import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Check,
  CircleHelp,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Terminal,
  X,
} from "lucide-react";
import { api, json, type Connection } from "./api";

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
    <span className={`provider ${name}`} aria-label={name}>
      <Terminal size={16} />
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
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const root = ref.current!;
    const focusable = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, select, summary, a[href], [tabindex="0"]',
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

export function ConnectionDialog({
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

export function Connections({
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
