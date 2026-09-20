import presetData from "./policyPresets.json";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, ShieldCheck, Terminal, GitBranch, FileText, Pencil, Trash2, History, Pause, Play, ChevronDown } from "lucide-react";
import { warnUntested, setWarnUntested } from "./PolicyPreferences";
import { Modal } from "./ui";
import { PolicyRequestPreview } from "./PolicyRequestPreview";
import { PolicyResults } from "./PolicyResults";
import { api, json, type Connection } from "./api";

type Activity = "read" | "write" | "shell" | "git_push" | "credentials" | "network" | "tool";
type Effect = "allow" | "review" | "deny" | "judge";
type Rule = { schema_version: 2; id: string; name: string; enabled: boolean; connection_ids: string[]; activity: Activity; roots: string[]; extensions: string[]; filenames: string[]; tool_name: string; command_contains: string; effect: Effect; expires_at: string | null };
type Version = { id: number; name: string; rules: Rule[]; created_at: string; previewed_at: string | null; trial_started_at: string | null; ever_active: boolean; applied_at?: string | null; changes?: {kind: string; id: string; name: string; before?: Rule; after?: Rule}[]; preview_result?: Preview | null; overlaps?: {rule_ids: string[]; winner_id: string}[]; conflicts: string[]; trial?: { sampled: number; allow: number; review: number; deny: number; judge: number; none: number; compared: number; different: number } };
type Policies = { revision: number; draft_id: number | null; paused_id: number | null; active_id: number | null; trial_id: number | null; versions: Version[]; changes: { action: string; version_id: number | null; created_at: string; actor: string }[] };
type Preview = { sampled: number; counts: Record<string, number>; conflicts: string[]; examples: { evaluation_id: string; tool: string; decision: string; reason: string; previous_decision?: string }[] };
const activities: Record<Activity, string> = { read: "Read files", write: "Write or edit files", shell: "Run shell commands", git_push: "Detected Git pushes", credentials: "Sensitive-file access", network: "Detected network requests", tool: "Use a specific tool" };
const effects: Record<Effect, string> = { allow: "Approve automatically", review: "Ask me", deny: "Block", judge: "Send to judge" };
type Preset = { name: string; activity: Activity; effect: Effect; icon: typeof FileText; detail: string; example: string; conditions: Partial<Pick<Rule, "filenames" | "command_contains" | "tool_name">>; suggested?: boolean };
const templateIcons = { ShieldCheck, FileText, GitBranch, Terminal };
const templates = presetData.map(p => ({ ...p, icon: templateIcons[p.icon as keyof typeof templateIcons] })) as Preset[];
const suggestedTemplates = templates.filter(t => t.suggested);
function presetRule(t: Preset): Rule {
  return { ...newRule(t.activity, t.effect, t.name), ...structuredClone(t.conditions) };
}
function newRule(activity: Activity = "shell", effect: Effect = "review", name = ""): Rule {
  return { schema_version: 2, id: crypto.randomUUID(), name, enabled: true, connection_ids: [], activity, roots: [], extensions: effect === "allow" ? [".md"] : [], filenames: [], tool_name: "", command_contains: "", effect, expires_at: null };
}
const split = (value: string) => value.split(/[\n,]/).map(x => x.trim()).filter(Boolean);


export function SafetyPolicies({ connections, close, attention }: { connections: Connection[]; close: () => void; attention?: { ruleId: string; incidentId: string } | null }) {
  const client = useQueryClient();
  const result = useQuery({ queryKey: ["policies"], queryFn: () => api<Policies>("/safety/policies"), refetchInterval: 3000 });
  const [tab, setTab] = useState<"draft" | "live">("draft");
  const [editor, setEditor] = useState<{ rule: Rule; rules: Rule[]; revision: number; scope: "all" | "selected"; generation: number } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [savingToggle, setSavingToggle] = useState(false);
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState(false);
  const [removeRule, setRemoveRule] = useState<{rule: Rule; revision: number} | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false), [hideWarning, setHideWarning] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const [testMode, setTestMode] = useState<"past" | "live" | null>(null);
  const data = result.data;
  const draft = data?.versions.find(v => v.id === data.draft_id);
  const live = data?.versions.find(v => v.id === (data.active_id ?? data.paused_id));
  const paused = !!data?.paused_id && !data.active_id;
  const current = tab === "draft" && draft ? draft : live;
  const isDraft = !!draft && current?.id === draft.id;
  const rules = current?.rules ?? [];
  const changes = ruleChanges(live?.rules ?? [], draft?.rules ?? live?.rules ?? []);
  const testing = !!draft && data?.trial_id === draft.id;
  const visibleTestMode = testMode ?? (testing ? "live" : "past");
  const preview = draft?.preview_result;
  const change = (patch: Partial<Rule>) => setEditor(e => e ? { ...e, rule: { ...e.rule, ...patch } } : e);
  async function run(work: () => Promise<void>, quiet = false) {
    setSavingToggle(quiet); setBusy(true); setError("");
    try { await work(); await client.invalidateQueries({ queryKey: ["policies"] }); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); setSavingToggle(false); }
  }
  function edit(rule: Rule) {
    if (draft && !isDraft) { setTab("draft"); return; }
    setEditor({ rule: structuredClone(rule), rules: structuredClone(rules), revision: data?.revision ?? 0, scope: rule.connection_ids.length ? "selected" : "all", generation: 0 });
    setError(""); setNotice(""); 
  }
  async function saveRules(rows: Rule[], revision: number) {
    const saved = await api<{ revision: number }>("/safety/policies/draft", json("PUT", { revision, name: "Working draft", rules: rows }));
    setTab("draft"); setEditor(null); setTestMode(null);
    setNotice("");
    return saved;
  }
  function transition(action: string, versionId = draft?.id) { void run(async () => {
    await api("/safety/policies/transition", json("POST", { revision: data!.revision, action, version_id: ["disable", "resume", "stop_trial"].includes(action) ? null : versionId }));
    
    if (action === "activate") { setTab("live"); setNotice(""); setTestMode(null); setShowChanges(false); setConfirmApply(false); }
    if (action === "trial") setTestMode("live");
  }); }
  function requestApply() {
    if (!draft?.previewed_at && warnUntested()) { setShowChanges(false); setHideWarning(false); setConfirmApply(true); }
    else transition("activate");
  }
  const focused = useRef(false);
  useEffect(() => {
    if (!attention || !data || focused.current) return;
    focused.current = true;
    const version = draft ?? live;
    const rule = version?.rules.find(r => r.id === attention.ruleId);
    if (!rule) { setNotice(draft ? "This rule isn't in the saved draft. Review the changes below before applying it." : "This rule is no longer in the applied policy."); return; }
    setTab(draft ? "draft" : "live");
    setEditor({ rule: structuredClone(rule), rules: structuredClone(version!.rules), revision: data.revision, scope: rule.connection_ids.length ? "selected" : "all", generation: 0 });
  }, [attention, data, draft, live]);
  const scopeText = (r: Rule) => r.connection_ids.length ? r.connection_ids.map(id => connections.find(c => c.id === id)?.name ?? "Removed connection").join(", ") : "All connections";
  const selectPreset = (t: Preset) => setEditor(e => e ? { ...e, generation: e.generation + 1, scope: "all", rule: { ...presetRule(t), id: e.rule.id } } : e);
  return <section className={`policy-workspace ${savingToggle ? "policy-toggle-saving" : ""}`} aria-label="Safety policies">
    <div className="policy-heading"><button className="secondary" onClick={close}><ArrowLeft size={15} />{attention ? "Back to Incidents" : "Back to Safety"}</button><h2>Policies</h2>{!editor && <><button className="secondary" aria-expanded={history} onClick={() => setHistory(!history)}><History size={15} />History</button><button className="primary" data-available={!!data} disabled={!data || busy} onClick={() => draft && !isDraft ? setTab("draft") : edit(newRule())}>{!(draft && !isDraft) && <Plus size={15} />}{draft && !isDraft ? "Open draft" : "Add rule"}</button></>}</div>
    {(error || result.error) && <p className="error" role="alert">{error || result.error?.message}</p>}
    {result.isPending && <p>Loading policies…</p>}
    {notice && <div className="policy-feedback" role="status">{notice}<button className="text-button" onClick={() => setNotice("")}>Dismiss</button></div>}
    {attention && data && <PolicyRequestPreview incidentId={attention.incidentId} revision={data.revision} hasDraft={!!draft} editing={!!editor} />}
    {editor ? <div className="policy-compose">
      <RuleEditor key={`${editor.rule.id}-${editor.generation}`} editor={editor} connections={connections} busy={busy} change={change} scope={scope => setEditor({ ...editor, scope, rule: { ...editor.rule, connection_ids: [] } })} cancel={() => setEditor(null)} save={() => {
        if (editor.scope === "selected" && !editor.rule.connection_ids.length) { setError("Choose at least one connection."); return; }
        const existing = editor.rules.some(r => r.id === editor.rule.id);
        const rows = existing ? editor.rules.map(r => r.id === editor.rule.id ? editor.rule : r) : [...editor.rules, editor.rule];
        if (!ruleChanges(editor.rules, rows).length) { setEditor(null); return; }
        void run(async () => { await saveRules(rows, editor.revision); });
      }} />
      <aside className="panel policy-presets" aria-label="Presets"><h3>Start with a preset</h3><p>Pick one to fill in the rule, then adjust it to fit.</p>{templates.map(t => <button key={t.name} type="button" data-available={true} disabled={busy} onClick={() => selectPreset(t)}><t.icon size={18} /><span><strong>{t.name}</strong><small>{t.detail}</small><code>{t.example}</code><span className={`policy-effect ${t.effect}`}>{effects[t.effect]}</span></span></button>)}</aside>
    </div> : <>
      {history && <section className="panel policy-history" aria-label="Policy history"><div className="policy-heading"><h3>Applied history</h3></div>
        {!data?.versions.some(v => v.ever_active) && <p>No policies applied yet.</p>}
        {data?.versions.filter(v => v.ever_active).sort((a, b) => (b.applied_at ?? b.created_at).localeCompare(a.applied_at ?? a.created_at)).map((v, index, releases) => {
          const delta: RuleChange[] = v.changes ? v.changes.map(c => ({ ...c, kind: (c.kind[0].toUpperCase() + c.kind.slice(1)) as RuleChange["kind"] })) : ruleChanges(releases[index + 1]?.rules ?? [], v.rules);
          return <details className="policy-release" key={v.id}><summary><strong>{new Date(v.applied_at ?? v.created_at).toLocaleString()}</strong><span>{v.id === data.active_id ? "Live" : v.id === data.paused_id ? "Paused" : changeSummary(delta)}</span><span className="policy-inspect-label">Inspect changes <ChevronDown size={14} /></span></summary>
            <ChangeList changes={delta} connections={connections} />{v.id !== data.active_id && <div className="policy-release-actions">{v.id !== data.active_id && <button className="secondary" disabled={busy || !!draft} title={draft ? "Discard the current draft before restoring" : undefined} onClick={() => void run(async () => { await api("/safety/policies/draft/restore", json("POST", { revision: data.revision, version_id: v.id })); setTab("draft"); setHistory(false); setShowChanges(true); setNotice("Restored to draft. Live rules are unchanged."); })}>Restore as draft</button>}{draft && v.id !== data.active_id && <button className="text-button" onClick={() => { setTab("draft"); setHistory(false); }}>Open existing draft</button>}</div>}
          </details>;
        })}
      </section>}
      <section className={`panel policy-rule-list ${paused && !isDraft ? "is-paused" : ""}`} aria-label="Rules">
        <div className="policy-list-heading"><div className="policy-view-switch">{draft ? <><button className={isDraft ? "selected" : ""} aria-pressed={isDraft} onClick={() => setTab("draft")}>Draft <span>{changes.length} {changes.length === 1 ? "change" : "changes"}</span></button><button className={!isDraft ? "selected" : ""} aria-pressed={!isDraft} onClick={() => setTab("live")}>{paused ? "Paused" : "Live"}</button></> : <h3>Rules{paused && <span className="policy-paused-badge">Paused</span>}</h3>}</div>
          <div className="policy-buttons">{isDraft ? <><button className="text-button" data-available={true} disabled={busy} onClick={() => setConfirmDiscard(true)}>Discard draft</button><button className="secondary" data-available={!!changes.length} disabled={busy || !changes.length} onClick={() => { setShowChanges(!showChanges); }}>Review changes</button><button className="primary" data-available={!!changes.length} disabled={busy || !changes.length} onClick={requestApply}>Apply changes</button></> : live ? <button className="secondary policy-pause-toggle" aria-pressed={paused} data-available={true} disabled={busy} onClick={() => transition(paused ? "resume" : "disable")}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? "Resume rules" : "Pause rules"}</button> : null}</div>
        </div>
        {data && !rules.length && (isDraft && (live?.rules.length ?? 0) > 0 ? <div className="policy-empty-inline">Applying removes all custom rules.</div> : draft && !isDraft ? <div className="policy-empty-inline">No live rules yet. Your draft is ready to review.<button className="text-button" onClick={() => setTab("draft")}>Open draft</button></div> : <div className="policy-empty">
          <div className="policy-empty-intro"><div className="policy-empty-illustration" aria-hidden="true"><FileText size={24} /><span /><ShieldCheck size={42} /><span /><GitBranch size={24} /></div><h3>A few rules go a long way</h3><p>No custom rules yet. Start with these four to keep secrets out of file reads and check changes that deserve a second look.</p></div>
          <div className="policy-starter-rules">{suggestedTemplates.map(t => <div key={t.name}><t.icon size={20} aria-hidden="true" /><div><strong>{t.name}</strong><p>{t.detail}</p><code>{t.example}</code></div><span className={`policy-effect ${t.effect}`}>{effects[t.effect]}</span></div>)}</div>
          <div className="policy-empty-actions"><button className="primary" disabled={busy} onClick={() => void run(async () => { await saveRules(suggestedTemplates.map(presetRule), data.revision); })}><Plus size={15} />Add suggested rules</button><button className="secondary" disabled={busy} onClick={() => edit(newRule())}>Write my own rule</button><p>Added as a draft for all connections. Edit or remove any rule before applying.</p></div>
        </div>)}
        {rules.map(r => <div className={`policy-row ${!r.enabled ? "disabled" : ""}`} key={r.id}><span className={`policy-effect ${r.effect}`}>{effects[r.effect]}</span><div className="policy-row-content"><strong>{r.name}{!r.enabled && <small> · Disabled</small>}{r.expires_at && <small> · {new Date(r.expires_at) <= new Date() ? "Expired" : `Expires ${new Date(r.expires_at).toLocaleString()}`}</small>}</strong><span>{activities[r.activity]} · {scopeText(r)}</span>{r.roots.length > 0 && <span>{r.roots.join(", ")}</span>}{(r.extensions.length > 0 || r.filenames.length > 0 || r.tool_name || r.command_contains) && <span>{[r.extensions.join(", "), r.filenames.join(", "), r.tool_name, r.command_contains && `Contains “${r.command_contains}”`].filter(Boolean).join(" · ")}</span>}</div>
          {(!draft || isDraft) && <div className="policy-row-actions"><label className="policy-rule-switch"><input type="checkbox" role="switch" aria-label={`Enable ${r.name}`} checked={r.enabled} data-available={true} disabled={busy} onChange={e => { const enabled = e.target.checked; void run(async () => { await saveRules(rules.map(row => row.id === r.id ? { ...row, enabled } : row), data!.revision); }, true); }} /></label><button className="icon-button" aria-label={`Edit ${r.name}`} data-available={true} disabled={busy} onClick={() => edit(r)}><Pencil size={16} /></button><button className="icon-button" aria-label={`Remove ${r.name}`} data-available={true} disabled={busy} onClick={() => setRemoveRule({rule: r, revision: data!.revision})}><Trash2 size={16} /></button></div>}
        </div>)}
        {rules.length > 0 && <div className="policy-priority" aria-label="Rule priority, highest first"><span>Priority (highest first)</span><div>{(["deny", "review", "judge", "allow"] as Effect[]).map((effect, index) => <span className="policy-priority-step" key={effect}>{index > 0 && <span aria-hidden="true">→</span>}<span className={`policy-effect ${effect}`}>{effects[effect]}</span></span>)}</div></div>}

      </section>
      {isDraft && <section className="panel policy-testing" aria-label="Draft simulation">
        <div className="policy-list-heading"><h3>Simulation</h3><div className="policy-simulation-controls"><div className="policy-view-switch" aria-label="Simulation source"><button aria-pressed={visibleTestMode === "past"} className={visibleTestMode === "past" ? "selected" : ""} onClick={() => setTestMode("past")}>Past requests</button><button aria-pressed={visibleTestMode === "live"} className={visibleTestMode === "live" ? "selected" : ""} onClick={() => setTestMode("live")}>Live requests{testing && <span className="policy-live-dot" aria-label="Running" />}</button></div>{visibleTestMode === "past" ? <button className="secondary" data-available={!!changes.length} disabled={busy || !changes.length} onClick={() => void run(async () => { await api(`/safety/policies/versions/${draft!.id}/preview?revision=${data!.revision}`, { method: "POST" }); setTestMode("past"); })}>Simulate past requests</button> : <button className="secondary" data-available={!!changes.length} disabled={busy || !changes.length} onClick={() => transition(testing ? "stop_trial" : "trial")}>{testing ? "Stop live simulation" : "Start live simulation"}</button>}</div></div>
        {((visibleTestMode === "past" && preview) || (visibleTestMode === "live" && draft?.trial_started_at)) && <div className="policy-test-body"><PolicyResults key={`${draft!.id}-${visibleTestMode}-${draft?.previewed_at}`} versionId={draft!.id} mode={visibleTestMode} /></div>}
      </section>}
      {confirmApply && isDraft && <Modal close={() => !busy && setConfirmApply(false)}><div className="policy-modal-content"><h2 id="dialog-title">Apply without simulating?</h2><p>This draft hasn’t been simulated against past requests. Applying it changes how new requests are handled.</p><label className="policy-preference"><input type="checkbox" checked={hideWarning} onChange={e => setHideWarning(e.target.checked)} />Don’t ask again in this browser</label><p className="safety-muted">You can turn this warning back on in Safety settings → Policies.</p>{error && <p role="alert" className="error">{error}</p>}<div className="policy-modal-actions"><button className="secondary" data-available={true} disabled={busy} onClick={() => setConfirmApply(false)}>Cancel</button><button className="primary" data-available={true} disabled={busy} onClick={() => { if (hideWarning) setWarnUntested(false); transition("activate"); }}>Apply anyway</button></div></div></Modal>}
      {confirmDiscard && <Modal close={() => !busy && setConfirmDiscard(false)}><div className="policy-modal-content"><h2 id="dialog-title">Discard draft?</h2><p>Live rules stay unchanged.</p>{error && <p role="alert" className="error">{error}</p>}<div className="policy-modal-actions"><button className="secondary" data-available={true} disabled={busy} onClick={() => setConfirmDiscard(false)}>Keep draft</button><button className="primary" data-available={true} disabled={busy} onClick={() => void run(async () => { await api(`/safety/policies/draft?revision=${data!.revision}`, { method: "DELETE" }); setConfirmDiscard(false); setTab("live"); setNotice(""); setTestMode(null); })}>Discard changes</button></div></div></Modal>}
      {removeRule && <Modal close={() => !busy && setRemoveRule(null)}><div className="policy-modal-content"><h2 id="dialog-title">Remove rule?</h2><div className="policy-remove-summary"><span className={`policy-effect ${removeRule.rule.effect}`}>{effects[removeRule.rule.effect]}</span><strong>{removeRule.rule.name}</strong></div><p>Saved to draft. Apply changes to update live rules.</p>{error && <p role="alert" className="error">{error}</p>}<div className="policy-modal-actions"><button className="secondary" data-available={true} disabled={busy} onClick={() => setRemoveRule(null)}>Cancel</button><button className="primary" data-available={true} disabled={busy} onClick={() => void run(async () => { await saveRules(rules.filter(r => r.id !== removeRule.rule.id), removeRule.revision); setRemoveRule(null); })}>Remove rule</button></div></div></Modal>}
      {showChanges && isDraft && <Modal close={() => !busy && setShowChanges(false)} wide><div className="policy-modal-content"><h2 id="dialog-title">Review changes</h2><ChangeList changes={changes} connections={connections} /><div className="policy-modal-actions"><button className="secondary" onClick={() => setShowChanges(false)}>Close</button><button className="primary" data-available={!!changes.length} disabled={busy || !changes.length} onClick={requestApply}>Apply changes</button></div></div></Modal>}
    </>}
  </section>;
}

type RuleChange = { kind: "Added" | "Changed" | "Removed"; name: string; before?: Rule; after?: Rule };
function ruleChanges(before: Rule[], after: Rule[]): RuleChange[] {
  const result: RuleChange[] = [];
  for (const rule of after) { const old = before.find(r => r.id === rule.id); if (!old) result.push({ kind: "Added", name: rule.name, after: rule }); else if (JSON.stringify(old) !== JSON.stringify(rule)) result.push({ kind: "Changed", name: rule.name, before: old, after: rule }); }
  for (const rule of before) if (!after.some(r => r.id === rule.id)) result.push({ kind: "Removed", name: rule.name, before: rule });
  return result;
}
function changeSummary(changes: RuleChange[]) { return ["Added", "Changed", "Removed"].map(k => { const n = changes.filter(c => c.kind === k).length; return n ? `${n} ${k.toLowerCase()}` : ""; }).filter(Boolean).join(" · ") || "No rule changes"; }
function ChangeList({ changes, connections }: { changes: RuleChange[]; connections: Connection[] }) { return <div className="policy-change-list">{!changes.length && <p>No changes.</p>}{changes.map(c => <div key={(c.after ?? c.before)!.id}><span className={`policy-change-kind ${c.kind.toLowerCase()}`}>{c.kind}</span><strong>{c.name}{!(c.after ?? c.before)!.enabled && " · Disabled"}{(c.after ?? c.before)!.expires_at && ` · Expires ${new Date((c.after ?? c.before)!.expires_at!).toLocaleString()}`}</strong>{c.kind !== "Changed" && <span>{effects[(c.after ?? c.before)!.effect]} · {activities[(c.after ?? c.before)!.activity]} · {formatField("connection_ids", (c.after ?? c.before)!.connection_ids, connections)}{(c.after ?? c.before)!.roots.length > 0 ? ` · ${(c.after ?? c.before)!.roots.join(", ")}` : ""}{[...(c.after ?? c.before)!.extensions, ...(c.after ?? c.before)!.filenames, (c.after ?? c.before)!.tool_name, (c.after ?? c.before)!.command_contains].filter(Boolean).length > 0 ? ` · ${[...(c.after ?? c.before)!.extensions, ...(c.after ?? c.before)!.filenames, (c.after ?? c.before)!.tool_name, (c.after ?? c.before)!.command_contains].filter(Boolean).join(", ")}` : ""}</span>}{c.kind === "Changed" && <span>{Object.keys(c.after!).filter(k => !["id", "schema_version"].includes(k) && JSON.stringify(c.before![k as keyof Rule]) !== JSON.stringify(c.after![k as keyof Rule])).map(k => `${({ effect: "Decision", activity: "Activity", roots: "Folders", connection_ids: "Connections", name: "Name", extensions: "Extensions", filenames: "Filenames", tool_name: "Tool", command_contains: "Command", expires_at: "Expiry", enabled: "Enabled" } as Record<string, string>)[k]}: ${formatField(k, c.before![k as keyof Rule], connections)} → ${formatField(k, c.after![k as keyof Rule], connections)}`).join("; ")}</span>}</div>)}</div>; }
function formatField(key: string, value: unknown, connections: Connection[]): string { if (key === "connection_ids" && Array.isArray(value)) return value.length ? value.map(id => connections.find(c => c.id === id)?.name ?? "Removed connection").join(", ") : "All connections"; if (key === "effect") return effects[value as Effect]; if (key === "activity") return activities[value as Activity]; if (Array.isArray(value)) return value.length ? value.join(", ") : key === "connection_ids" ? "All" : "Any"; return value === null || value === "" ? "None" : String(value); }

function RuleEditor({ editor, connections, busy, change, scope, cancel, save }: { editor: { rule: Rule; scope: "all" | "selected" }; connections: Connection[]; busy: boolean; change: (p: Partial<Rule>) => void; scope: (s: "all" | "selected") => void; cancel: () => void; save: () => void }) {
  const r = editor.rule;
  const mixedScope = r.activity === "credentials" || r.activity === "tool";
  const file = r.activity === "read" || r.activity === "write";
  const [folders, setFolders] = useState(r.roots.join("\n"));
  const [extensions, setExtensions] = useState(r.extensions.join(", "));
  const [filenames, setFilenames] = useState(r.filenames.join(", "));
  return <form className="panel policy-editor" onSubmit={e => { e.preventDefault(); save(); }}>
    <div className="policy-heading"><h3>{editor.rule.name || "New rule"}</h3><span className="safety-muted">Changes stay in draft</span></div>
    <div className="policy-fields">
      <label className="policy-wide">Rule name<input required maxLength={100} autoFocus value={r.name} onChange={e => change({ name: e.target.value })} placeholder="e.g. Ask before pushing code" /></label>
      <label>When<select aria-label="When" value={r.activity} onChange={e => { const activity = e.target.value as Activity; change({ activity, effect: activity !== "read" && r.effect === "allow" ? "review" : r.effect, extensions: [], filenames: [], command_contains: "", tool_name: "", roots: [] }); setExtensions(""); setFilenames(""); setFolders(""); }}>{Object.entries(activities).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      <label>Then<select aria-label="Then" value={r.effect} onChange={e => { const effect = e.target.value as Effect; change({ effect, ...(effect === "allow" && !r.extensions.length ? { extensions: [".md"] } : {}) }); if (effect === "allow" && !r.extensions.length) setExtensions(".md"); }}><option value="review">Ask me</option><option value="deny">Block</option><option value="judge">Send to judge</option>{r.activity === "read" && <option value="allow">Approve automatically</option>}</select></label>
      {r.activity === "tool" && <label className="policy-wide">Exact tool name<input required value={r.tool_name} placeholder="e.g. mcp__github__create_pull_request" onChange={e => change({ tool_name: e.target.value })} /></label>}
      <label className="policy-wide">Connections<select aria-label="Connections" value={editor.scope} onChange={e => scope(e.target.value as "all" | "selected")}><option value="all">All connections (including new ones)</option><option value="selected">Selected connections</option></select></label>
      {editor.scope === "selected" && <fieldset className="policy-connection-options policy-wide"><legend>Apply to</legend>{connections.map(c => <label key={c.id}><input type="checkbox" checked={r.connection_ids.includes(c.id)} onChange={e => change({ connection_ids: e.target.checked ? [...r.connection_ids, c.id] : r.connection_ids.filter(id => id !== c.id) })} />{c.name}</label>)}{!connections.length && <p>Add a connection in Connections first.</p>}</fieldset>}
      <label className="policy-wide">{file ? "Within folders" : mixedScope ? "Folders" : "Working directories"}{r.effect !== "allow" && " (optional)"}<textarea rows={2} required={r.effect === "allow"} value={folders} placeholder={file ? "Absolute folder paths, one per line" : "Leave empty for any working directory"} onChange={e => { setFolders(e.target.value); change({ roots: e.target.value.split("\n").map(x => x.trim()).filter(Boolean) }); }} /></label>
      {file && <label>File extensions{r.effect !== "allow" && " (optional)"}<input required={r.effect === "allow"} value={extensions} placeholder=".md, .txt" onChange={e => { setExtensions(e.target.value); change({ extensions: split(e.target.value) }); }} /></label>}
      {file && <label>File names (optional)<input value={filenames} placeholder=".env, .env.*, *.pem" onChange={e => { setFilenames(e.target.value); change({ filenames: split(e.target.value) }); }} /></label>}
    </div>
    {r.expires_at && <p className="safety-muted">Existing expiry: {new Date(r.expires_at).toLocaleString()}</p>}
    <details className="policy-advanced" open={!!r.command_contains || !!r.tool_name && r.activity !== "tool"}><summary>More conditions</summary><div className="policy-fields">
      {!file && <label className="policy-wide">Command contains (optional)<input maxLength={200} value={r.command_contains} placeholder="Literal text, not a regular expression" onChange={e => change({ command_contains: e.target.value })} /></label>}
      {r.activity !== "tool" && <label>Exact tool name (optional)<input value={r.tool_name} onChange={e => change({ tool_name: e.target.value })} /></label>}


    </div></details>
    <div className="policy-editor-actions"><button type="button" className="secondary" data-available={true} disabled={busy} onClick={cancel}>Cancel</button><button className="primary" data-available={true} disabled={busy}>Save rule</button></div>
  </form>;
}
