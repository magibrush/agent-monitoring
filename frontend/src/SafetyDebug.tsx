import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, json } from "./api";

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
    <h3>Debug</h3>
    <label className="safety-debug-toggle"><span>Debug mode</span><input type="checkbox" role="switch" aria-label="Debug mode" checked={config?.enabled ?? false} disabled={!config || busy} onChange={event => save({ ...config!, enabled: event.target.checked })} /></label>
    {config?.enabled && <div className="safety-debug-options">
      <label className="field">Forced judge result<select aria-label="Forced judge result" value={config.result} disabled={busy} onChange={event => save({ enabled: true, result: event.target.value as DebugConfig["result"] })}>
        <option value="review">Review — require human approval</option>
        <option value="allow">Allow — release the action</option>
        <option value="deny">Deny — block the action</option>
      </select></label>
      <p className="safety-muted">Overrides custom policies and the judge for new assessments. Built-in checks and deadlines still apply.</p>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
