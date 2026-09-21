import { Activity, Bell, ShieldCheck, X } from "lucide-react";
import type { Connection } from "./api";
import { Modal } from "./ui";
import { PolicyPreferences } from "./PolicyPreferences";
import { SafetyDebug, type DebugConfig } from "./SafetyDebug";
import type { SafetyNotifications } from "./useSafetyNotifications";

export type SafetyStatus = {
  model: string;
  key_configured: boolean;
  key_file: string;
  debug?: DebugConfig;
  workers: unknown[];
  counts: Record<string, number>;
  performance?: {
    requests: number;
    automatic_pause: { p95_ms: number | null; samples: number };
    failed: number;
    expired: number;
    missing_receipts: number;
    truncated: boolean;
  };
};

export function SafetySettings({ status, error, connections, notifications, close, configure }: {
  status?: SafetyStatus;
  error?: string;
  connections: Connection[];
  notifications: SafetyNotifications;
  close: () => void;
  configure: (connection: Connection) => void;
}) {
  const performance = status?.performance;
  return <Modal close={close}>
    <div className="modal-heading safety-settings-heading">
      <div><h2 id="dialog-title">Safety settings</h2><p>Manage protection, alerts, and evaluation.</p></div>
      <button className="icon-button" aria-label="Close safety settings" onClick={close}><X size={20} /></button>
    </div>
    <div className="safety-settings-body">
      {error && <p className="error" role="alert">Could not load safety status: {error}</p>}
      <section className="safety-settings-section" aria-labelledby="protection-settings-title">
        <h3 id="protection-settings-title"><ShieldCheck size={17} />Protection by connection</h3>
        <p className="settings-description">Choose how each connection handles tool requests.</p>
        <div className="settings-card">
          {!connections.length && <p className="settings-empty">Add a connection to configure protection.</p>}
          {connections.map(connection => <div className="safety-setting-row" key={connection.id}>
            <div><strong>{connection.name}</strong><small>{!connection.hooks_enabled ? "Hooks not installed" : connection.gate_enabled ? "Blocking configured" : "Shadow configured"}</small></div>
            <button className="secondary" aria-label={`Configure protection for ${connection.name}`} onClick={() => configure(connection)}>Configure</button>
          </div>)}
        </div>
        <p className="settings-footnote">Restart sessions after changes. Configured modes do not guarantee hook coverage. Blocking requests expire after 60 seconds, including human review; shadow mode only records assessments.</p>
      </section>

      <section className="safety-settings-section" aria-labelledby="preferences-settings-title">
        <h3 id="preferences-settings-title"><Bell size={17} />Preferences</h3>
        <div className="settings-card">
          <div className="settings-preference-row">
            <div><strong>Notifications</strong><p>{notifications.supported ? "Get alerts for requests that need your attention. Keep a Relay tab open." : "Notifications are not supported in this browser."}</p></div>
            <button className="secondary" onClick={notifications.toggle} disabled={!notifications.supported}>{notifications.enabled ? "Turn off notifications" : "Enable notifications"}</button>
          </div>
          {notifications.error && <p className="error settings-inline-error" role="alert">{notifications.error}</p>}
          <PolicyPreferences />
        </div>
      </section>

      <section className="safety-settings-section" aria-labelledby="evaluation-settings-title">
        <h3 id="evaluation-settings-title"><Activity size={17} />Evaluation</h3>
        <div className="settings-card settings-evaluation">
          <div className="settings-judge-heading"><div><strong>Judge</strong><p>{status?.model ?? (error ? "Status unavailable" : "Loading status...")}</p></div><span className={`settings-status ${status?.key_configured && status.workers.length ? "healthy" : ""}`}>{!status ? (error ? "Unavailable" : "Loading...") : !status.key_configured ? "API key needed" : !status.workers.length ? "Worker offline" : "Connected"}</span></div>
          <details className="settings-disclosure">
            <summary>Judge setup</summary>
            <p>Place your Anthropic API key in this local file. The worker reads it automatically.</p>
            <code className="safety-path">{status?.key_file || "Key file path unavailable"}</code>
            <p>Start the worker with <code>scripts/start-worker.ps1</code>.</p>
          </details>
          <details className="settings-disclosure">
            <summary>Performance <span>Last 24 hours</span></summary>
            {performance ? <><dl className="settings-metrics">
              <div><dt title="95% of measured automatic pauses finished within this time">Automatic pause (p95)</dt><dd>{performance.automatic_pause.p95_ms == null ? "—" : `${(performance.automatic_pause.p95_ms / 1000).toFixed(2)} s`}</dd></div>
              <div><dt>Requests</dt><dd>{performance.requests.toLocaleString()}{performance.truncated ? "+" : ""}</dd></div>
              <div><dt>Failed / expired</dt><dd>{performance.failed} / {performance.expired}</dd></div>
              <div><dt>Missing receipts</dt><dd>{performance.missing_receipts}</dd></div>
            </dl><p className="settings-footnote">Pause timing is based on {performance.automatic_pause.samples} receipts.{performance.truncated && " Showing the latest 10,000 requests."}</p></> : <p>Performance data is not available yet.</p>}
          </details>
          <div className="settings-data-note"><strong>Data sharing</strong><p>Action arguments and limited conversation context are sent to Anthropic for evaluation. Secret redaction is limited.</p></div>
        </div>
      </section>
      <SafetyDebug config={status?.debug} />
    </div>
  </Modal>;
}
