import { useState } from "react";
const key = "relay.policy.warnUntested";
export function warnUntested() { try { return localStorage.getItem(key) !== "false"; } catch { return true; } }
export function setWarnUntested(value: boolean) { try { localStorage.setItem(key, String(value)); } catch { /* Storage unavailable: keep warning enabled. */ } }
export function PolicyPreferences() {
  const [enabled, setEnabled] = useState(warnUntested);
  return <section><h3>Policies</h3><label className="policy-preference"><input type="checkbox" role="switch" checked={enabled} onChange={e => { setEnabled(e.target.checked); setWarnUntested(e.target.checked); }} />Warn before applying an unsimulated draft</label></section>;
}
