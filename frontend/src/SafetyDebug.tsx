import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, json } from "./api";
import { FlaskConical } from "lucide-react";

export type DebugConfig = { enabled: boolean; result: "review" | "allow" | "deny" };
export function SafetyDebug({ config }: { config?: DebugConfig }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(next: DebugConfig) {
    setBusy(true); setError("");
    try {
      const saved = await api<DebugConfig>("/safety/debug", json("PUT", next));
      client.setQueryData<{ debug: DebugConfig }>(["safety"], previous => previous && ({ ...previous, debug: saved }));
      await client.invalidateQueries({ queryKey: ["safety"] });
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="safety-debug" aria-label="Debug settings">
    <h3><FlaskConical size={17} />Danger zone</h3>
    <div className="safety-debug-card">
    <label className="safety-debug-toggle"><span><strong>Debug mode</strong><small>{config?.enabled ? "Active · new assessments use a forced result" : "For testing only"}</small></span><input className="settings-switch" type="checkbox" role="switch" aria-label="Debug mode" aria-describedby="debug-description" checked={config?.enabled ?? false} disabled={!config || busy} onChange={event => save({ ...config!, enabled: event.target.checked })} /></label>
    <p id="debug-description">Overrides custom policies and the judge for new assessments. Built-in checks and deadlines still apply.</p>
    {config && !config.enabled && <p className="debug-next-result">When enabled: <strong>{{ review: "Review — require human approval", allow: "Allow — release the action", deny: "Deny — block the action" }[config.result]}</strong></p>}
    {config?.enabled && <div className="safety-debug-options">
      <label className="field">Forced judge result<select aria-label="Forced judge result" value={config.result} disabled={busy} onChange={event => save({ enabled: true, result: event.target.value as DebugConfig["result"] })}>
        <option value="review">Review — require human approval</option>
        <option value="allow">Allow — release the action</option>
        <option value="deny">Deny — block the action</option>
      </select></label>
      <p>Changes apply to new requests. Turn off debug mode to restore normal evaluation.</p>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
    </div>
  </section>;
}
