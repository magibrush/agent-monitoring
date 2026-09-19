import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { api, providerLabel, type Metrics, type Session } from "./api";
import { Conversation } from "./Conversation";
import { Modal } from "./ui";
import {
  categoricalSeries,
  cumulativeSegments,
  MESSAGE_SERIES,
  ColorKey,
  SeriesTooltipRow,
  CHART_PALETTE,
} from "./chartSeries";
import { ChartTooltip } from "./ChartTooltip";
import { RangeNavigator } from "./RangeNavigator";
import { SAFETY_SERIES, SafetyInspection } from "./Safety";

const intervals = [
  [60, "1 minute"],
  [300, "5 minutes"],
  [900, "15 minutes"],
  [3600, "1 hour"],
  [21600, "6 hours"],
  [86400, "1 day"],
  [604800, "1 week"],
  [2592000, "30 days"],
  [31536000, "1 year"],
] as const;
const count = (n: number) => n.toLocaleString();
const date = (n: number | string) => new Date(n).toLocaleString();

const conversationColorAssignments = new Map<string, string>();

export function Timeline({
  params,
  colorBy,
  setColorBy,
  safetyWorkspace = false,
}: {
  safetyWorkspace?: boolean;
  params: string;
  colorBy: string;
  setColorBy: (value: string) => void;
}) {
  const [safetyOutcome, setSafetyOutcome] = useState("");
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [actionPage, setActionPage] = useState(0);
  const [actionSearch, setActionSearch] = useState("");
  const [viewport, setViewport] = useState<{
    start: string;
    end: string;
  } | null>(null);
  const [interval, setInterval] = useState("0");
  const [scale, setScale] = useState("linear");
  const conversationColors = useRef(conversationColorAssignments);
  const effectiveScale = colorBy === "conversation" || colorBy === "safety" ? "linear" : scale;
  const [bucket, setBucket] = useState<number | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [lane, setLane] = useState("actions");
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const [contributorOffset, setContributorOffset] = useState(0);
  const [opened, setOpened] = useState<Session | null>(null);
  const query = new URLSearchParams(params);
  query.set("interval", interval);
  query.set("conversations", String(colorBy === "conversation"));
  if (viewport) {
    query.set("view_start", viewport.start);
    query.set("view_end", viewport.end);
  }
  const result = useQuery({
    queryKey: ["timeline", query.toString()],
    placeholderData: (previous) => previous,
    queryFn: () => api<Metrics>(`/metrics?${query}`),
  });
  const data = result.data;
  const overview = useQuery({
    queryKey: ["metrics", params],
    queryFn: () => api<Metrics>(`/metrics?${params}`),
  });
  const narrow = new URLSearchParams(params);
  if (data) {
    narrow.set(
      "start",
      bucket === null
        ? data.viewport.start
        : new Date(
            Math.max(bucket, Date.parse(data.viewport.start)),
          ).toISOString(),
    );
    narrow.set(
      "end",
      bucket === null
        ? data.viewport.end
        : new Date(
            Math.min(
              Date.parse(data.viewport.end),
              bucket + data.interval_seconds * 1000,
            ),
          ).toISOString(),
    );
  }
  if (lane === "actions" && !narrow.get("action")) narrow.set("action", "any");
  const detailParams = new URLSearchParams(narrow);
  if (!new URLSearchParams(params).get("action")) detailParams.delete("action");
  const contributorKey = narrow.toString();
  useEffect(() => setContributorOffset(0), [contributorKey, lane]);
  const contributors = useQuery({
    queryKey: ["contributors", narrow.toString(), lane, contributorOffset],
    enabled: Boolean(data) && inspecting && !safetyWorkspace,
    queryFn: () =>
      api<{ total: number; items: Session[] }>(
        `/sessions?${narrow}&sort=${lane === "actions" ? "actions" : "messages"}&limit=5&offset=${contributorOffset}`,
      ),
  });
  function windowTo(low: number, high: number) {
    if (!data) return;
    const min = Date.parse(data.domain.start),
      max = Date.parse(data.domain.end);
    const width = Math.min(
      max - min,
      interval === "0" ? Infinity : Number(interval) * 600 * 1000,
      Math.max(60000, high - low),
    );
    low = Math.max(min, Math.min(low, max - width));
    setViewport({
      start: new Date(low).toISOString(),
      end: new Date(low + width).toISOString(),
    });
    setBucket(null);
    setDrag(null);
  }
  function change(factor: number, direction = 0) {
    if (!data) return;
    const low = Date.parse(data.viewport.start),
      high = Date.parse(data.viewport.end),
      width = high - low;
    const center = (low + high) / 2 + direction * width * 0.8;
    windowTo(center - (width * factor) / 2, center + (width * factor) / 2);
  }
  function reset() {
    setViewport(null);
    setInterval("0");
    setBucket(null);
  }
  const transform = (n: number) =>
    effectiveScale === "log" ? Math.log10(1 + n) : n;
  const usedColors = new Set<string>();
  const reservedColors = new Set(
    (data?.conversation_series ?? [])
      .map((s) => conversationColors.current.get(s.id))
      .filter(Boolean),
  );
  const conversationSeries = (data?.conversation_series ?? []).map((s) => {
    let color =
      s.id === "other" ? "#8792a2" : conversationColors.current.get(s.id);
    if (!color || usedColors.has(color))
      color =
        CHART_PALETTE.find(
          (c) => !usedColors.has(c) && !reservedColors.has(c),
        ) ??
        CHART_PALETTE.find((c) => !usedColors.has(c)) ??
        "#8792a2";
    usedColors.add(color);
    conversationColors.current.set(s.id, color);
    return { ...s, color, key: `conversation_${s.id}` };
  });
  const rankSlots = Array.from(
    {
      length: Math.min(
        10,
        Math.max(0, ...(data?.series ?? []).map((r) => r.tools.length)),
      ),
    },
    (_, index) => ({
      key: `series_${index}`,
      label: `Rank ${index + 1}`,
      color: CHART_PALETTE[index],
    }),
  );
  const actionSeries = [
    ...rankSlots,
    ...((data?.series ?? []).some((r) => r.tools.length > 10)
      ? [{ key: "series_other", label: "Other actions", color: "#94a3b8" }]
      : []),
  ];
  const actionTotals = new Map<string, number>();
  for (const row of data?.series ?? []) {
    if (bucket !== null && row.time !== bucket) continue;
    for (const tool of row.tools)
      actionTotals.set(
        tool.name,
        (actionTotals.get(tool.name) ?? 0) + tool.count,
      );
  }
  const inspectedActions = [...actionTotals].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const matchingActions = inspectedActions.filter(([name]) =>
    name.toLowerCase().includes(actionSearch.toLowerCase()),
  );
  const safeActionPage = Math.min(
    actionPage,
    Math.max(0, Math.ceil(matchingActions.length / 10) - 1),
  );
  const rows =
    data?.series.map((r) => {
      const ranked = categoricalSeries(r.tools);
      const parts = cumulativeSegments(
        ranked.map((series) =>
          r.tools
            .filter((t) => series.members.includes(t.name))
            .reduce((sum, t) => sum + t.count, 0),
        ),
        transform,
      );
      return {
        ...r,
        ...Object.fromEntries(SAFETY_SERIES.map(s => [`safety_${s.key}`, r.safety?.[s.key] ?? 0])),
        ranked,
        ...Object.fromEntries(
          conversationSeries.flatMap((s) => {
            const item = r.conversations?.find((c) => c.id === s.id);
            return [
              [`${s.key}_actions`, item?.actions ?? 0],
              [`${s.key}_messages`, item?.messages ?? 0],
            ];
          }),
        ),
        plotUser: transform(r.user),
        plotAssistant: transform(r.user + r.assistant) - transform(r.user),
        ...Object.fromEntries(
          actionSeries.map((series) => [
            series.key,
            parts[ranked.findIndex((s) => s.key === series.key)] ?? 0,
          ]),
        ),
      };
    }) ?? [];
  const tick = (t: number) =>
    new Date(t).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      ...(data && data.interval_seconds < 86400
        ? ({ hour: "2-digit", minute: "2-digit" } as const)
        : ({ year: "2-digit" } as const)),
    });
  const zoomed = Boolean(
    data &&
    (data.viewport.start !== data.domain.start ||
      data.viewport.end !== data.domain.end),
  );
  function plot(kind: "actions" | "messages") {
    if (!data) return null;
    const maximum = Math.max(
      1,
      ...data.series.map((r) =>
        kind === "actions" ? r.actions : r.user + r.assistant,
      ),
    );
    const rawTicks = [
      0,
      1,
      ...Array.from(
        { length: Math.ceil(Math.log10(maximum)) + 1 },
        (_, i) => 10 ** (i + 1),
      ),
    ].filter((v) => v <= maximum * 10);
    const maxLog = rawTicks.find((v) => v >= maximum) ?? maximum;
    return (
      <div
        onMouseMoveCapture={(event) =>
          setPointer({ x: event.clientX, y: event.clientY })
        }
        className="signal-plot"
        aria-label={`${kind} by time`}
        data-testid={`${kind}-chart`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows}
            margin={{ left: 0, right: 20, top: 12, bottom: 0 }}
            onMouseDown={(s) => {
              if (s.activeLabel != null)
                setDrag({
                  start: Number(s.activeLabel),
                  end: Number(s.activeLabel),
                });
            }}
            onMouseMove={(s) => {
              if (drag && s.activeLabel != null)
                setDrag({ ...drag, end: Number(s.activeLabel) });
            }}
            onMouseUp={() => {
              if (!drag) return;
              const { start, end } = drag;
              setDrag(null);
              if (start === end) {
                setBucket(start);
                setLane(kind);
                setInspecting(true);
              } else
                windowTo(
                  Math.min(start, end),
                  Math.max(start, end) + data.interval_seconds * 1000,
                );
            }}
          >
            <CartesianGrid
              stroke="#e8ebef"
              strokeDasharray="3 4"
              vertical={false}
            />
            <XAxis
              dataKey="time"
              tickFormatter={tick}
              minTickGap={70}
              tick={{ fontSize: 11, fill: "#5b687b" }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              width={52}
              allowDecimals={false}
              domain={
                effectiveScale === "log" ? [0, transform(maxLog)] : [0, "auto"]
              }
              ticks={
                effectiveScale === "log"
                  ? rawTicks.filter((v) => v <= maxLog).map(transform)
                  : undefined
              }
              tickFormatter={(v) =>
                count(
                  effectiveScale === "log"
                    ? Math.round(10 ** Number(v) - 1)
                    : Number(v),
                )
              }
              tick={{ fontSize: 11, fill: "#5b687b" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              content={({ active, payload }) => {
                const r = payload?.[0]?.payload;
                if (!active || !r) return null;
                return (
                  <ChartTooltip point={pointer}>
                    <strong>
                      {date(r.time)} —{" "}
                      {date(
                        Math.min(
                          Date.parse(data.viewport.end),
                          r.time + data.interval_seconds * 1000,
                        ),
                      )}
                    </strong>

                    {colorBy === "safety" && kind === "actions" ? <><b>{count(r.actions)} proposed actions</b>{SAFETY_SERIES.map(s => <SeriesTooltipRow key={s.key} label={s.label} color={s.color} value={r.safety?.[s.key] ?? 0} />)}<small>{r.safety?.flagged ?? 0} risk flags (independent of outcome). Click for evidence.</small></> : colorBy === "conversation" ? (
                      <>
                        <b>
                          {count(
                            kind === "actions"
                              ? r.actions
                              : r.user + r.assistant,
                          )}{" "}
                          {kind}
                        </b>
                        {conversationSeries
                          .filter((s) => r[`${s.key}_${kind}`] > 0)
                          .map((s) => (
                            <SeriesTooltipRow
                              key={s.id}
                              label={s.title}
                              color={s.color}
                              value={r[`${s.key}_${kind}`]}
                            />
                          ))}
                        <small>Click for conversations and exact shares</small>
                      </>
                    ) : kind === "actions" ? (
                      <>
                        <b>{count(r.actions)} actions</b>
                        {(r.ranked as ReturnType<typeof categoricalSeries>)
                          .map((series) => ({
                            ...series,
                            count: r.tools
                              .filter((t: { name: string; count: number }) =>
                                series.members.includes(t.name),
                              )
                              .reduce(
                                (sum: number, t: { count: number }) =>
                                  sum + t.count,
                                0,
                              ),
                          }))
                          .filter((series) => series.count > 0)
                          .map((series) => (
                            <SeriesTooltipRow
                              key={series.key}
                              label={
                                series.key === "series_other"
                                  ? `Other actions (${r.tools.filter((t: { name: string }) => series.members.includes(t.name)).length} types)`
                                  : series.label
                              }
                              color={series.color}
                              value={series.count}
                              percent={
                                r.actions ? (series.count / r.actions) * 100 : 0
                              }
                            />
                          ))}
                        <small className="compact-tooltip-note">
                          Partial preview; full breakdown in Inspect.
                        </small>
                        <small>
                          Click bar to inspect all {r.tools.length} action types
                        </small>
                      </>
                    ) : (
                      <>
                        <b>{count(r.user + r.assistant)} messages</b>
                        {MESSAGE_SERIES.map((s) => (
                          <SeriesTooltipRow
                            key={s.key}
                            label={s.label}
                            color={s.color}
                            value={r[s.key]}
                          />
                        ))}
                      </>
                    )}
                  </ChartTooltip>
                );
              }}
            />
            {colorBy === "safety" && kind === "actions" ? SAFETY_SERIES.map(s => <Bar key={s.key} name={s.label} stackId="actions" dataKey={`safety_${s.key}`} fill={s.color} maxBarSize={18} isAnimationActive={false} />) : colorBy === "conversation" ? (
              conversationSeries.map((s) => (
                <Bar
                  key={s.id}
                  name={s.title}
                  stackId={kind}
                  dataKey={`${s.key}_${kind}`}
                  fill={s.color}
                  maxBarSize={18}
                  isAnimationActive={false}
                />
              ))
            ) : kind === "actions" ? (
              actionSeries.map((s) => (
                <Bar
                  key={s.key}
                  name={s.label}
                  stackId="actions"
                  dataKey={s.key}
                  fill={s.color}
                  maxBarSize={18}
                  isAnimationActive={false}
                />
              ))
            ) : (
              <>
                <Bar
                  name="User"
                  stackId="messages"
                  dataKey="plotUser"
                  fill={MESSAGE_SERIES[0].color}
                  maxBarSize={18}
                  isAnimationActive={false}
                />
                <Bar
                  name="Assistant"
                  stackId="messages"
                  dataKey="plotAssistant"
                  fill={MESSAGE_SERIES[1].color}
                  maxBarSize={18}
                  isAnimationActive={false}
                />
              </>
            )}
            {bucket !== null && (
              <ReferenceArea
                x1={bucket}
                x2={bucket + data.interval_seconds * 1000}
                fill="#536abd"
                fillOpacity={0.12}
              />
            )}
            {drag && drag.start !== drag.end && (
              <ReferenceArea
                x1={Math.min(drag.start, drag.end)}
                x2={Math.max(drag.start, drag.end)}
                fill="#536abd"
                fillOpacity={0.18}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }
  return (
    <section className={`panel timeline-panel signals-panel ${safetyWorkspace ? "safety-timeline" : ""}`}>
      {safetyWorkspace && <div className="panel-heading"><div><h2>Action decisions over time</h2><p className="safety-muted">Select an outcome or a bar to inspect the actions behind it.</p></div></div>}
      <div className="chart-toolbar">
        {" "}
        <div className="signal-settings">
          {!safetyWorkspace && <label>
            Color by{" "}
            <select
              aria-label="Color bars by"
              value={colorBy}
              onChange={(e) => setColorBy(e.target.value)}
            >
              <option value="activity">Action rank per bar</option>
              <option value="conversation">Conversation</option>
              <option value="safety">Safety outcome</option>
            </select>
          </label>}
          <label>
            Interval{" "}
            <select
              aria-label="Bucket size"
              value={interval}
              onChange={(e) => {
                setInterval(e.target.value);
                setBucket(null);
              }}
            >
              <option value="0">
                Auto{data ? ` · ${data.interval_label}` : ""}
              </option>
              {intervals.map(([v, l]) => (
                <option value={v} key={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {!safetyWorkspace && <label>
            Scale{" "}
            <select
              aria-label="Vertical scale"
              title="Logarithmic scale preserves zero counts; hover for exact values"
              value={effectiveScale}
              disabled={colorBy === "conversation" || colorBy === "safety"}
              onChange={(e) => setScale(e.target.value)}
            >
              <option value="log">Logarithmic</option>
              <option value="linear">Linear</option>
            </select>
          </label>}
        </div>
        {data && (
          <div className="window-toolbar">
            <div className="button-group">
              <button
                aria-label="Pan earlier"
                disabled={
                  Date.parse(data.viewport.start) <=
                  Date.parse(data.domain.start)
                }
                onClick={() => change(1, -1)}
              >
                <ChevronLeft size={15} />
                Earlier
              </button>
              <button
                aria-label="Zoom in"
                disabled={
                  Date.parse(data.viewport.end) -
                    Date.parse(data.viewport.start) <=
                  60000
                }
                onClick={() => change(0.5)}
              >
                <ZoomIn size={15} />
              </button>
              <button
                aria-label="Zoom out"
                disabled={
                  !zoomed ||
                  (interval !== "0" &&
                    (Date.parse(data.viewport.end) -
                      Date.parse(data.viewport.start)) /
                      1000 >=
                      Number(interval) * 600)
                }
                title={
                  interval !== "0"
                    ? "Zoom out at the chosen resolution; limited to 600 buckets"
                    : "Zoom out"
                }
                onClick={() => change(2)}
              >
                <ZoomOut size={15} />
              </button>
              <button
                aria-label="Pan later"
                disabled={
                  Date.parse(data.viewport.end) >= Date.parse(data.domain.end)
                }
                onClick={() => change(1, 1)}
              >
                Later
                <ChevronRight size={15} />
              </button>
              <button
                aria-label="Reset zoom"
                disabled={!zoomed && interval === "0"}
                onClick={reset}
              >
                <Maximize2 size={14} />
                Full range · Auto
              </button>
            </div>
            {!safetyWorkspace && <button
              className="secondary"
              aria-label="Inspect activity"
              aria-expanded={inspecting}
              onClick={() => setInspecting(!inspecting)}
            >
              Inspect
            </button>}
          </div>
        )}{" "}
      </div>{" "}
      {data?.safety && <div className="safety-chart-summary" aria-label="Safety outcomes in selected scope">
        {SAFETY_SERIES.map(s => <button key={s.key} className="text-button" aria-pressed={safetyOutcome === s.key} onClick={() => { setSafetyOutcome(safetyOutcome === s.key ? "" : s.key); setColorBy("safety"); setInspecting(true); setLane("actions"); }}><span><ColorKey color={s.color} />{s.label}: </span><b>{data.safety?.[s.key] ?? 0}</b></button>)}
        <strong>{data.safety.flagged ?? 0} flagged risks</strong>
      </div>}
      {colorBy === "safety" && <p className="rank-explanation">One state per proposed action, at its request time. Released means the hook continued to native permissions, not execution success. Denied is a policy decision; delivery is shown in details. Risk flags are separate. Totals follow the selected scope; bars follow the visible window.</p>}
      {colorBy === "activity" && (
        <p className="rank-explanation">
          Each bar ranks its own actions. Colors show rank, not action identity.
          Gray combines ranks 11 onward. Click a bar for details.
          {effectiveScale === "log"
            ? " Log scale: segment sizes are not proportional shares."
            : ""}
        </p>
      )}
      {colorBy === "conversation" && (
        <div className="conversation-legend" aria-label="Conversation colors">
          <p>
            Colors show conversations; Other combines the rest. Linear scale
            shows their shares. Click a bar to inspect.
          </p>
          {conversationSeries
            .filter((s) =>
              rows.some(
                (r) =>
                  Number(r[`${s.key}_actions` as keyof typeof r]) ||
                  Number(r[`${s.key}_messages` as keyof typeof r]),
              ),
            )
            .map((s) => (
              <span
                key={s.id}
                title={`${s.title}${s.connection_name ? ` · ${s.connection_name}` : ""}`}
              >
                <ColorKey color={s.color} />
                {s.title}
              </span>
            ))}
        </div>
      )}
      {result.error && (
        <div className="error" role="alert">
          {result.error.message}
        </div>
      )}
      {data && data.sessions > 0 ? (
        <>
          <div className="window-caption" role="status">
            {date(data.viewport.start)} — {date(data.viewport.end)} ·{" "}
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
            {data.window_limited && (
              <b title="Use Earlier and Later to navigate at this resolution">
                600-bucket window
              </b>
            )}
          </div>
          <div
            className={`investigation-grid ${inspecting && !safetyWorkspace ? "with-inspector" : ""}`}
          >
            <div className="signal-charts">
              <div className="signal-heading">
                <h3>Actions</h3>
              </div>
              {plot("actions")}
              {!safetyWorkspace && <><div className="signal-heading">
                <h3>Messages</h3>
                {colorBy !== "conversation" && (
                  <span
                    title={
                      scale === "log"
                        ? "Logarithmic cumulative counts; segment heights are not proportional shares"
                        : "Stacked message counts"
                    }
                  >
                    <ColorKey color={MESSAGE_SERIES[0].color} />
                    User <ColorKey color={MESSAGE_SERIES[1].color} />
                    Assistant
                  </span>
                )}
              </div>
              {plot("messages")}</>}
              {overview.data && (
                <RangeNavigator
                  overview={overview.data}
                  viewport={data.viewport}
                  interval={Number(interval)}
                  onChange={windowTo}
                />
              )}
            </div>
            {inspecting && !safetyWorkspace && (
              <aside className="contribution-panel">
                <div className="contribution-heading">
                  <h3>
                    {bucket === null
                      ? "Sessions in this window"
                      : "Sessions in this bucket"}
                  </h3>
                  {bucket !== null && (
                    <button
                      className="text-button"
                      onClick={() => setBucket(null)}
                    >
                      Clear bucket
                    </button>
                  )}
                </div>
                {bucket !== null && (
                  <p className="contribution-time">
                    {date(Math.max(bucket, Date.parse(data.viewport.start)))} —{" "}
                    {date(
                      Math.min(
                        Date.parse(data.viewport.end),
                        bucket + data.interval_seconds * 1000,
                      ),
                    )}
                  </p>
                )}
                <button
                  className="text-button"
                  onClick={() => setInspecting(false)}
                >
                  Close
                </button>
                <label>
                  Rank by{" "}
                  <select
                    aria-label="Rank contributors"
                    value={lane}
                    onChange={(e) => setLane(e.target.value)}
                  >
                    <option value="actions">Actions</option>
                    <option value="messages">Messages</option>
                  </select>
                </label>
                <label className="bucket-select">
                  Inspect
                  <select
                    aria-label="Inspect time bucket"
                    value={bucket ?? ""}
                    onChange={(e) =>
                      setBucket(e.target.value ? Number(e.target.value) : null)
                    }
                  >
                    <option value="">Visible window</option>
                    {data.series
                      .filter((r) => r.actions || r.user || r.assistant)
                      .map((r) => (
                        <option key={r.time} value={r.time}>
                          {date(r.time)} · {r.actions} actions ·{" "}
                          {r.user + r.assistant} messages
                        </option>
                      ))}
                  </select>
                </label>
                {lane === "actions" && (
                  <section
                    className="action-breakdown"
                    aria-label="Action breakdown"
                  >
                    {colorBy === "safety" && <SafetyInspection key={narrow.toString()} params={narrow.toString()} outcome={safetyOutcome} onOutcomeChange={setSafetyOutcome} />}
                    <h3>Action types ({inspectedActions.length})</h3>
                    <label>
                      Find an action
                      <input
                        aria-label="Find an action"
                        value={actionSearch}
                        onChange={(e) => {
                          setActionSearch(e.target.value);
                          setActionPage(0);
                        }}
                      />
                    </label>
                    {bucket === null && (
                      <p>
                        Window totals. Select a bar to see its ranks and colors.
                      </p>
                    )}
                    {matchingActions
                      .slice(safeActionPage * 10, safeActionPage * 10 + 10)
                      .map(([name, amount]) => (
                        <SeriesTooltipRow
                          key={name}
                          label={name}
                          value={amount}
                          percent={
                            (amount /
                              (inspectedActions.reduce(
                                (sum, [, count]) => sum + count,
                                0,
                              ) || 1)) *
                            100
                          }
                          color={
                            bucket === null
                              ? "#94a3b8"
                              : (CHART_PALETTE[
                                  inspectedActions.findIndex(
                                    ([tool]) => tool === name,
                                  )
                                ] ?? "#94a3b8")
                          }
                        />
                      ))}
                    <small>
                      {matchingActions.length ? safeActionPage * 10 + 1 : 0}–
                      {Math.min(
                        (safeActionPage + 1) * 10,
                        matchingActions.length,
                      )}{" "}
                      of {matchingActions.length} action types
                    </small>
                    <div className="contributor-pages">
                      <button
                        className="secondary"
                        aria-label="Previous action types"
                        disabled={safeActionPage === 0}
                        onClick={() => setActionPage(safeActionPage - 1)}
                      >
                        Previous
                      </button>
                      <button
                        className="secondary"
                        aria-label="Next action types"
                        disabled={
                          (safeActionPage + 1) * 10 >= matchingActions.length
                        }
                        onClick={() => setActionPage(safeActionPage + 1)}
                      >
                        Next
                      </button>
                    </div>
                  </section>
                )}
                {contributors.data?.items.map((s) => {
                  const total = data.series
                    .filter((r) => bucket === null || r.time === bucket)
                    .reduce(
                      (n, r) =>
                        n +
                        (lane === "actions" ? r.actions : r.user + r.assistant),
                      0,
                    );
                  const amount = lane === "actions" ? s.actions : s.messages;
                  const percent = total ? (amount / total) * 100 : 0;
                  const color =
                    colorBy === "conversation"
                      ? (conversationSeries.find((c) => c.id === s.id)?.color ??
                        "#8792a2")
                      : "#5069ba";
                  return (
                    <button
                      className="contributor"
                      key={s.id}
                      onClick={() => setOpened(s)}
                    >
                      <strong title={s.title}>
                        <ColorKey color={color} />
                        {s.title}
                      </strong>
                      <small>
                        {providerLabel(s.provider)}
                        {s.connection_name !== providerLabel(s.provider)
                          ? ` · ${s.connection_name}`
                          : ""}
                      </small>
                      <span>
                        {count(s.actions)} action{s.actions === 1 ? "" : "s"} ·{" "}
                        {count(s.messages)} message{s.messages === 1 ? "" : "s"}
                      </span>
                      <span className="contribution-share">
                        <span
                          style={{
                            width: `${Math.min(100, percent)}%`,
                            background: color,
                          }}
                        />
                      </span>
                      <small>
                        {count(amount)}{" "}
                        {amount === 1 ? lane.slice(0, -1) : lane} ·{" "}
                        {percent.toFixed(1)}% of{" "}
                        {bucket === null ? "window" : "bar"}
                      </small>
                    </button>
                  );
                })}
                {!contributors.data?.items.length && (
                  <p>
                    {contributors.isPending
                      ? "Loading sessions…"
                      : "No recorded activity here."}
                  </p>
                )}
                {contributors.error && (
                  <p role="alert">{contributors.error.message}</p>
                )}
                <small>
                  Showing {contributors.data?.total ? contributorOffset + 1 : 0}
                  –{contributorOffset + (contributors.data?.items.length ?? 0)}{" "}
                  of {contributors.data?.total ?? 0} sessions
                </small>
                <div className="contributor-pages">
                  <button
                    className="secondary"
                    aria-label="Previous contributors"
                    disabled={!contributorOffset}
                    onClick={() =>
                      setContributorOffset(Math.max(0, contributorOffset - 5))
                    }
                  >
                    Previous
                  </button>
                  <button
                    className="secondary"
                    aria-label="Next contributors"
                    disabled={
                      contributorOffset + 5 >= (contributors.data?.total ?? 0)
                    }
                    onClick={() => setContributorOffset(contributorOffset + 5)}
                  >
                    Next
                  </button>
                </div>
              </aside>
            )}
          </div>
        </>
      ) : (
        <div className="empty">
          <h3>
            {result.isPending
              ? "Loading activity…"
              : "No activity in this selection"}
          </h3>
          <p>Choose a different range or clear the filters.</p>
        </div>
      )}
      {safetyWorkspace && <div className="safety-review-area">
        <div className="safety-review-scope"><span>{bucket !== null ? `Selected interval: ${date(bucket)} · ${data?.interval_label ?? ""}` : "Actions in the visible time window"}</span>{bucket !== null && <button className="text-button" onClick={() => setBucket(null)}>Clear interval</button>}</div>
        <SafetyInspection key={narrow.toString()} params={narrow.toString()} outcome={safetyOutcome} onOutcomeChange={setSafetyOutcome} />
      </div>}
      {opened && (
        <Modal wide close={() => setOpened(null)}>
          <button
            className="icon-button close-conversation"
            aria-label="Close conversation"
            onClick={() => setOpened(null)}
          >
            <X size={20} />
          </button>
          <Conversation
            session={opened}
            params={detailParams.toString()}
            initialKind={
              narrow.get("q")
                ? ""
                : lane === "actions" && opened.actions > 0
                  ? "tool_call"
                  : "message"
            }
          />
        </Modal>
      )}
    </section>
  );
}
