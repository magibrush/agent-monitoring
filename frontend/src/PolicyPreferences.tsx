import { useState } from "react";
const key = "relay.policy.warnUntested";
export function warnUntested() { try { return localStorage.getItem(key) !== "false"; } catch { return true; } }
export function setWarnUntested(value: boolean) { try { localStorage.setItem(key, String(value)); } catch { /* Storage unavailable: keep warning enabled. */ } }
export function PolicyPreferences() {
  const [enabled, setEnabled] = useState(warnUntested);
  return <div className="settings-preference-row"><label className="settings-policy-preference"><span><strong>Policies</strong><span className="settings-preference-description" id="policy-warning-description">Warn before applying an unsimulated draft. Saved in this browser.</span></span><input className="settings-switch" type="checkbox" role="switch" aria-label="Warn before applying an unsimulated draft" aria-describedby="policy-warning-description" checked={enabled} onChange={e => { setEnabled(e.target.checked); setWarnUntested(e.target.checked); }} /></label></div>;
}
