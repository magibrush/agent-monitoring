import { useRef, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { type Connection, type Metrics } from "./api";
import { ACTIONS } from "./Conversation";
import { FIT, TimeRange, type Range } from "./TimeRange";

export const DEFAULT_FILTERS = {
  connection: "", sessionType: "", search: "", scope: "messages",
  mode: "words", action: "", tool: "", internal: false,
};
export type InvestigationFilterValues = typeof DEFAULT_FILTERS;

const scopes = [
  ["messages", "Messages + titles", "Search messages or session titles…"],
  ["actions", "Tool arguments + output", "Search commands, paths, or tool output…"],
  ["all", "Messages + tools + titles", "Search messages, tools, or session titles…"],
  ["titles", "Session titles only", "Search session titles…"],
] as const;

export function InvestigationFilters({ value, onChange, connections, query, clearSearch, range,
  onRangeChange, zoomRange, resetZoom, clearAll, canClear,
}: {
  value: InvestigationFilterValues;
  onChange: (patch: Partial<InvestigationFilterValues>) => void;
  connections: Connection[];
  query: string;
  clearSearch: () => void;
  range: Range;
  onRangeChange: (range: Range) => void;
  zoomRange: Metrics["viewport"] | null;
  resetZoom: () => void;
  clearAll: () => void;
  canClear: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const activeScope = scopes.find(([id]) => id === value.scope) ?? scopes[0];
  const chips: { key: string; label: string; title?: string; remove: () => void }[] = [];
  function chip(key: keyof InvestigationFilterValues, label: string) {
    if (value[key] !== DEFAULT_FILTERS[key]) chips.push({ key, label, remove: () => onChange({ [key]: DEFAULT_FILTERS[key] }) });
  }
  chip("connection", `Connection: ${connections.find(c => c.id === value.connection)?.name ?? value.connection}`);
  chip("sessionType", `Sessions: ${value.sessionType === "subagent" ? "Subagents" : "Conversations"}`);
  chip("action", `Action: ${ACTIONS.find(([id]) => id === value.action)?.[1] ?? value.action}`);
  chip("tool", `Tool: ${value.tool}`);
  if (query) chips.push({ key: "search", label: `Search: ${query}`, remove: clearSearch });
  chip("scope", `Search in: ${activeScope[1]}`);
  chip("mode", "Match: Contains substring");
  chip("internal", "Internal reviews included");
  if (range.start || range.end || range.lastSeconds) chips.push({ key: "time", label: `Time: ${range.label}`, remove: () => onRangeChange(FIT) });
  if (zoomRange) {
    const shortDate = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    chips.push({ key: "zoom", label: `Chart zoom: ${shortDate(zoomRange.start)} – ${shortDate(zoomRange.end)}`,
      title: `${new Date(zoomRange.start).toLocaleString()} – ${new Date(zoomRange.end).toLocaleString()}`, remove: resetZoom });
  }

  return <section className="filter-panel investigation-filters" aria-label="Investigation filters" onKeyDown={e => {
    if (e.key === "Escape" && expanded) { setExpanded(false); trigger.current?.focus(); }
  }}>
    <div className="investigation-bar">
      <label className="search investigation-query">
        <Search size={16} aria-hidden="true" />
        <input aria-label="Search conversations" maxLength={200} placeholder={activeScope[2]} value={value.search} onChange={e => onChange({ search: e.target.value })} />
        {value.search && <button aria-label="Clear search" onClick={clearSearch}><X size={14} /></button>}
      </label>
      <button ref={trigger} className="investigation-toggle" aria-label="Filters" aria-describedby={chips.length ? "investigation-filter-count" : undefined} aria-expanded={expanded} aria-controls="investigation-options" onClick={() => setExpanded(!expanded)}>
        <SlidersHorizontal size={15} aria-hidden="true" />Filters{chips.length > 0 && <><span className="filter-count" aria-hidden="true">{chips.length}</span><span id="investigation-filter-count" hidden>{chips.length} active filters</span></>}
      </button>
      <div className="investigation-time"><TimeRange value={range} onChange={onRangeChange} /></div>
      <button className="clear-all" disabled={!canClear} onClick={clearAll}>Clear filters</button>
    </div>
    {expanded && <div id="investigation-options" className="investigation-options">
      <div className="investigation-groups">
        <fieldset><legend>Sources</legend>
          <label className="investigation-field"><span>Connection</span>
            <select aria-label="Filter connection" value={value.connection} onChange={e => onChange({ connection: e.target.value })}>
              <option value="">All connections</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="investigation-field"><span>Session type</span>
            <select aria-label="Session type" value={value.sessionType} onChange={e => onChange({ sessionType: e.target.value })}>
              <option value="">All session types</option><option value="conversation">Conversations</option><option value="subagent">Subagents</option>
            </select>
          </label>
        </fieldset>
        <fieldset><legend>Activity</legend>
          <label className="investigation-field"><span>Action category</span>
            <select aria-label="Action filter" value={value.action} onChange={e => onChange({ action: e.target.value })}>
              {ACTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <label className="investigation-field"><span>Tool name contains</span>
            <input aria-label="Filter tool name" maxLength={200} placeholder="e.g. exec_command, Bash, Read" value={value.tool} onChange={e => onChange({ tool: e.target.value })} />
          </label>
          <div className="investigation-internal">
            <label><input type="checkbox" checked={value.internal} disabled={Boolean(value.sessionType)} onChange={e => onChange({ internal: e.target.checked })} aria-describedby="internal-review-hint" />Include internal reviews</label>
            <p id="internal-review-hint">{value.sessionType ? "Choose All session types to include internal reviews." : "Include agent-generated review sessions."}</p>
          </div>
        </fieldset>
        <fieldset><legend>Search options</legend>
          <label className="investigation-field"><span>Search in</span>
            <select aria-label="Search scope" value={value.scope} onChange={e => onChange({ scope: e.target.value })}>
              {scopes.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <label className="investigation-field"><span>Search matching</span>
            <select aria-label="Search matching" value={value.mode} onChange={e => onChange({ mode: e.target.value })}>
              <option value="words">Whole word / phrase</option><option value="contains">Contains substring</option>
            </select>
          </label>
        </fieldset>
      </div>
      {chips.length > 0 && <div className="investigation-chips" aria-label="Active filters">
        <span>Active filters</span>{chips.map(c => <button key={c.key} title={c.title ?? c.label} aria-label={`Remove ${c.label}`} onClick={c.remove}><span>{c.label}</span><X size={12} aria-hidden="true" /></button>)}
      </div>}
    </div>}
  </section>;
}
