import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "./api";

type Match = { conditions?: string[]; id: string; name: string; effect: string; activity?: string; roots?: string[]; extensions?: string[]; filenames?: string[]; tool_name?: string; command_contains?: string };
type Result = { evaluation_id: string; tool: string; title: string; connection_name: string; occurred_at: string; action: string; previous_decision: string | null; decision: string; reason: string; explanation: string; conditions: string[]; rule_ids: string[]; matched_rules: Match[]; winner_id?: string; builtin?: boolean };
type Results = { items: Result[]; total: number; sampled: number; counts: Record<string, number>; offset: number; limit: number; cap: number; tested_at: string | null; rerun_required?: boolean };
const labels: Record<string, string> = { all: "All", allow: "Approve", review: "Ask me", deny: "Block", judge: "Judge", none: "Not matched", unavailable: "Unavailable" };
const previousLabels: Record<string, string> = { allow: "Allow", review: "Review", deny: "Deny", judge: "Judge", none: "Not assessed" };
function excerpt(item: Result) { try { const action = JSON.parse(item.action); const args = action.tool_input ?? action; return typeof args === "string" ? args.slice(0, 180) : String(args.command ?? args.cmd ?? args.file_path ?? args.path ?? item.reason).slice(0, 180); } catch { return item.reason; } }
function actionParts(raw: string) { try { const value = JSON.parse(raw); return { text: JSON.stringify(value.tool_input ?? value, null, 2), cwd: value.cwd }; } catch { return { text: raw, cwd: null }; } }

export function PolicyResults({ versionId, mode }: { versionId: number; mode: "past" | "live" }) {
  const [decision, setDecision] = useState("all"), [search, setSearch] = useState(""), [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const result = useQuery({ queryKey: ["policy-results", versionId, mode, decision, search, offset], queryFn: () => api<Results>(`/safety/policies/versions/${versionId}/results?${new URLSearchParams({ mode, decision, q: search, offset: String(offset), limit: "20" })}`), refetchInterval: mode === "live" ? 3000 : false });
  const data = result.data;
  const selected = data?.items.find(i => i.evaluation_id === selectedId);
  const choose = (value: string) => { setDecision(value); setOffset(0); setSelectedId(null); };
  const inspector = useRef<HTMLElement>(null);
  useEffect(() => { if (selectedId && window.matchMedia("(max-width: 700px)").matches) inspector.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [selectedId]);
  const parts = selected ? actionParts(selected.action) : null;
  return <div className="policy-results" aria-label="Policy test results">
    {result.error && <p role="alert" className="error">{result.error.message}<button className="text-button" onClick={() => void result.refetch()}>Retry</button></p>}
    {data?.rerun_required ? <p className="policy-results-empty">Run Simulate past requests again to inspect this older test.</p> : <>
      <div className="policy-result-cards">{Object.entries(labels).map(([key, label]) => <button key={key} aria-pressed={decision === key} onClick={() => choose(key)} className={`policy-result-card ${decision === key ? "selected" : ""}`}><span><i className={`policy-dot ${key}`} />{label}</span><strong>{key === "all" ? data?.sampled ?? "—" : data?.counts[key] ?? "—"}</strong></button>)}</div>
      <div className="policy-result-tools"><label><Search size={15} /><input aria-label="Search test results" placeholder="Search commands, sessions or rules…" value={search} onChange={e => { setSearch(e.target.value); setOffset(0); setSelectedId(null); }} /></label><span>{data ? `${data.sampled} sampled · latest ${data.cap.toLocaleString()} maximum` : "Loading…"}{data?.tested_at && ` · ${new Date(data.tested_at).toLocaleString()}`}</span></div>
      <div className="policy-results-layout">
        <section className="policy-result-list" aria-label="Test requests"><div className="policy-result-rows" aria-busy={result.isFetching}>
          {result.isPending && <p className="policy-results-empty">Loading requests…</p>}
          {data && !data.items.length && <p className="policy-results-empty">{search || decision !== "all" ? "No results match these filters." : mode === "live" ? "Waiting for new requests." : "No past requests to test"}</p>}
          {data?.items.map(item => <button className={`policy-result-row ${selectedId === item.evaluation_id ? "selected" : ""}`} key={item.evaluation_id} onClick={() => setSelectedId(item.evaluation_id)} aria-pressed={selectedId === item.evaluation_id}><div><strong>{item.tool || "Unknown tool"}</strong><span className={`policy-effect ${item.decision}`}>{labels[item.decision] ?? item.decision}</span></div><code>{excerpt(item)}</code><small>{item.title || "Untitled session"} · {item.occurred_at ? new Date(item.occurred_at).toLocaleString() : "Unknown time"}</small></button>)}
        </div><div className="policy-result-pagination"><span>{data?.total ? `${offset + 1}–${Math.min(offset + 20, data.total)} of ${data.total}` : "0 results"}</span><button className="icon-button" aria-label="Previous test results" disabled={!offset || result.isFetching} onClick={() => { setOffset(Math.max(0, offset - 20)); setSelectedId(null); }}><ChevronLeft size={17} /></button><button className="icon-button" aria-label="Next test results" disabled={!data || offset + 20 >= data.total || result.isFetching} onClick={() => { setOffset(offset + 20); setSelectedId(null); }}><ChevronRight size={17} /></button></div></section>
        <section ref={inspector} className="policy-result-inspector" aria-label="Test request details">{!selected ? <div className="policy-result-placeholder"><Search size={26} /><span>Select a request</span></div> : <>
          <div className="policy-inspect-heading"><h3>{selected.tool}</h3><span>{selected.connection_name}</span></div>
          <div className="policy-decision-comparison"><div><small>Recorded assessment</small><strong>{previousLabels[selected.previous_decision ?? ""] ?? selected.previous_decision ?? "Unavailable"}</strong></div><span>→</span><div><small>Draft decision</small><strong className={`policy-effect ${selected.decision}`}>{labels[selected.decision] ?? selected.decision}</strong></div></div>
          <div className="policy-result-reason"><strong>{selected.reason}</strong><p>{selected.explanation}</p>{selected.conditions?.length > 0 && <ul>{selected.conditions.map((c, i) => <li key={i}>{c}</li>)}</ul>}</div>
          {!!selected.matched_rules?.length && <div className="policy-matched-rules"><h4>Matched rules</h4>{selected.matched_rules.map(rule => <div key={rule.id}><span className={`policy-effect ${rule.effect}`}>{labels[rule.effect]}</span><strong>{rule.name}</strong>{selected.winner_id === rule.id && <small>Takes priority</small>}<span>{[rule.conditions?.join(" · "), rule.roots?.join(", "), rule.extensions?.join(", "), rule.filenames?.join(", "), rule.tool_name, rule.command_contains && `Contains “${rule.command_contains}”`].filter(Boolean).join(" · ")}</span></div>)}</div>}
          <div className="policy-result-command"><h4>Requested action</h4>{parts?.cwd && <code className="policy-result-cwd">{parts.cwd}</code>}<pre>{parts?.text || "No saved input available."}</pre></div>
        </>}</section>
      </div>
    </>}
  </div>;
}
