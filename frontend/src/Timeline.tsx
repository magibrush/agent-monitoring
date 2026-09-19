import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Search,
} from "lucide-react";
import { api, providerLabel, type Session, type Metrics } from "./api";
import {
  categoricalSeries,
  cumulativeSegments,
  MESSAGE_SERIES,
  SeriesTooltipRow,
  CHART_PALETTE,
} from "./chartSeries";
import { ChartTooltip } from "./ChartTooltip";
import { useTimeChart, TimeChartControls, TimeChartCaption } from "./TimeChart";
import { RangeNavigator } from "./RangeNavigator";
import { SAFETY_SERIES } from "./Safety";

const count = (n: number) => n.toLocaleString();
const date = (n: number | string) => new Date(n).toLocaleString();


export function Timeline({
  params,
  onViewportChange,
  onOpenSession,
  colorBy,
  setColorBy,
  chartKind = "actions",
}: {
  chartKind?: "sessions" | "messages" | "actions";
  params: string;
  onOpenSession: (session: Session, kind?: string) => void;
  onViewportChange?: (viewport: Metrics["viewport"] | null) => void;
  colorBy: string;
  setColorBy: (value: string) => void;
}) {
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [plotWidth, setPlotWidth] = useState(0);
  const inspectionScroll = useRef<HTMLDivElement>(null);
  const [inspectionHeight, setInspectionHeight] = useState(0);
  function preserveInspectionHeight() {
    if (inspectionScroll.current) setInspectionHeight(inspectionScroll.current.scrollHeight - 16);
  }
  const [actionPage, setActionPage] = useState(0);
  const [scale, setScale] = useState("linear");
  const tokenMode = chartKind === "sessions" && colorBy === "tokens";
  const effectiveScale = colorBy === "conversation" || colorBy === "safety" ? "linear" : scale;
  const [inspecting, setInspecting] = useState(false);
  const lane = chartKind;
  const [contributorOffset, setContributorOffset] = useState(0);
  const chart = useTimeChart(params, chartKind !== "sessions" && colorBy === "conversation", onViewportChange);
  const { result, overview, data, interval, bucket, setBucket, drag, setDrag, windowTo, narrow } = chart;
  useEffect(() => { setActionPage(0); setContributorOffset(0); setInspectionHeight(0); }, [chartKind, bucket, data?.viewport.start, data?.viewport.end]);
  if (lane === "actions" && !narrow.get("action")) narrow.set("action", "any");
  const contributorKey = narrow.toString();
  useEffect(() => setContributorOffset(0), [contributorKey, lane]);
  const contributors = useQuery({
    queryKey: ["contributors", narrow.toString(), lane, contributorOffset],
    enabled: Boolean(data) && inspecting && chartKind !== "actions",
    placeholderData: (previous, query) => query?.queryKey[1] === narrow.toString() && query.queryKey[2] === lane ? previous : undefined,
    queryFn: () =>
      api<{ total: number; items: Session[] }>(
        `/sessions?${narrow}&sort=${lane === "actions" ? "actions" : lane === "sessions" ? "recent" : "messages"}&messages_only=${chartKind === "messages"}&limit=5&offset=${contributorOffset}`,
      ),
  });
  const transform = (n: number) =>
    effectiveScale === "log" ? Math.log10(1 + n) : n;
  const conversationSeries = data?.conversation_series ?? [];
  const rankedMode = colorBy === "conversation" || colorBy === "safety";
  function composition(r: NonNullable<typeof data>["series"][number]) {
    const entries = colorBy === "conversation"
      ? (r.conversations ?? []).map(c => ({ name: c.id, count: chartKind === "actions" ? c.actions : c.messages }))
      : SAFETY_SERIES.map(c => ({ name: c.key, count: r.safety?.[c.key] ?? 0 }));
    return categoricalSeries(entries).map(s => ({ ...s,
      label: s.key === "series_other" ? "Other conversations" : colorBy === "conversation"
        ? conversationSeries.find(c => c.id === s.label)?.title ?? s.label
        : SAFETY_SERIES.find(c => c.key === s.label)?.label ?? s.label,
      count: entries.filter(c => s.members.includes(c.name)).reduce((n, c) => n + c.count, 0),
    }));
  }
  const compositionSlots = [...CHART_PALETTE.map((color, i) => ({ key: `series_${i}`, color })), { key: "series_other", color: "#94a3b8" }];
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
  const matchingActions = inspectedActions;
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
        composition: composition(r),
        ...Object.fromEntries(composition(r).map(s => [`composition_${s.key}`, s.count])),
        plotInput: transform(r.input_tokens ?? 0),
        plotOutput: transform((r.input_tokens ?? 0) + (r.output_tokens ?? 0)) - transform(r.input_tokens ?? 0),
        plotSessions: transform(r.sessions ?? 0),
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
  function plot(kind: "sessions" | "actions" | "messages") {
    if (!data) return null;
    const maximum = Math.max(
      1,
      ...data.series.map((r) =>
        kind === "sessions" ? (tokenMode ? (r.input_tokens ?? 0) + (r.output_tokens ?? 0) : r.sessions ?? 0) : kind === "actions" ? r.actions : r.user + r.assistant,
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
        onContextMenu={chart.onContextMenu}
        onMouseDownCapture={e => { if (e.button !== 0) e.stopPropagation(); }}
        onMouseUpCapture={e => { if (e.button !== 0) e.stopPropagation(); }}
        tabIndex={0}
        onKeyDown={e => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) || !rows.length) return;
          e.preventDefault();
          const current = rows.findIndex(r => r.time === bucket);
          const index = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (e.key === "ArrowLeft" ? -1 : 1)));
          setBucket(rows[index].time); setInspecting(true);
        }}
      >
        <ResponsiveContainer width="100%" height="100%" onResize={width => setPlotWidth(width)}>
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
            onMouseUp={() => { if (drag) setInspecting(true); chart.finishDrag(); }}
            onMouseLeave={() => setDrag(null)}
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

                    {tokenMode ? <>{r.input_tokens == null && r.output_tokens == null ? <span>Token usage not reported</span> : <>{r.input_tokens != null && <SeriesTooltipRow label="Input tokens" color="#5069ba" value={r.input_tokens} />}{r.output_tokens != null && <SeriesTooltipRow label="Output tokens" color="#398678" value={r.output_tokens} />}{r.tokens_partial && <small>Partial usage reported</small>}</>}</> : kind === "sessions" ? <SeriesTooltipRow label="Active sessions" color="#5069ba" value={r.sessions ?? 0} /> : rankedMode ? (
                      <>
                        <b>{count(kind === "actions" ? r.actions : r.user + r.assistant)} {kind}</b>
                        {(r.composition as ReturnType<typeof composition>).map(s => <SeriesTooltipRow key={s.key} label={s.label} color={s.color} value={s.count} percent={s.count / (kind === "actions" ? r.actions : r.user + r.assistant) * 100} />)}
                        <small className="compact-tooltip-note">Partial preview.</small>
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
                          Partial preview.
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
            {tokenMode ? <><Bar name="Input tokens" stackId="tokens" dataKey="plotInput" fill="#5069ba" maxBarSize={18} isAnimationActive={false} /><Bar name="Output tokens" stackId="tokens" dataKey="plotOutput" fill="#398678" maxBarSize={18} isAnimationActive={false} /></> : kind === "sessions" ? <Bar name="Active sessions" dataKey="plotSessions" fill="#5069ba" maxBarSize={18} isAnimationActive={false} /> : rankedMode ? compositionSlots.map(s => <Bar key={s.key} stackId={kind} dataKey={`composition_${s.key}`} fill={s.color} maxBarSize={18} isAnimationActive={false} />) : kind === "actions" ? (
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
              <ReferenceLine x={bucket} stroke="#536abd" strokeWidth={Math.max(1, Math.min(18, (plotWidth - 72) / rows.length * 0.8))} strokeOpacity={0.14} pointerEvents="none" />
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
    <div className="overview-chart-layout">
    <section className="panel timeline-panel signals-panel">
      <div className="unified-chart-heading"><h2>{tokenMode ? "Tokens" : chartKind === "sessions" ? "Active sessions" : chartKind === "messages" ? "Messages" : "Actions"}</h2></div>
      <TimeChartControls chart={chart}>
        {chartKind === "sessions" && <label>Color by <select aria-label="Color bars by" value={colorBy} onChange={e => setColorBy(e.target.value)}><option value="activity">Sessions</option><option value="tokens">Tokens · input / output</option></select></label>}
        {chartKind !== "sessions" && <label>Color by <select aria-label="Color bars by" value={colorBy} onChange={e => setColorBy(e.target.value)}><option value="activity">{chartKind === "messages" ? "Role" : "Action rank per bar"}</option><option value="conversation">Conversation</option>{chartKind === "actions" && <option value="safety">Safety outcome</option>}</select></label>}
        <label>Scale <select aria-label="Vertical scale" value={effectiveScale} disabled={colorBy === "conversation" || colorBy === "safety"} onChange={e => setScale(e.target.value)}><option value="linear">Linear</option><option value="log">Logarithmic</option></select></label>
      </TimeChartControls>
      {result.error && (
        <div className="error" role="alert">
          {result.error.message}
        </div>
      )}
      {data && data.sessions > 0 ? (
        <>
          <TimeChartCaption chart={chart} />
          <div
            className="investigation-grid"
          >
            <div className="signal-charts">
              {tokenMode && !data.series.some(r => r.input_tokens != null || r.output_tokens != null) ? <div className="token-empty">Token usage not reported for this selection</div> : plot(chartKind)}
              {overview.data && (
                <RangeNavigator
                  kind={tokenMode ? "tokens" : chartKind}
                  overview={overview.data}
                  viewport={data.viewport}
                  interval={Number(interval)}
                  onChange={windowTo}
                />
              )}
            </div>
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
    </section>
    <aside className="panel bar-inspector" aria-label="Bar inspection">
      {!inspecting ? <div className="inspection-placeholder"><Search size={28} strokeWidth={1.5} /><span>Click on a bar to inspect</span></div> : <>
        <div className="inspection-heading"><h3>{chartKind === "actions" ? "Actions" : chartKind === "sessions" ? "Sessions" : "Messages"}</h3></div>
        <p className="inspection-time">{date(narrow.get("start")!)} — {date(narrow.get("end")!)}</p>
        <div className="inspection-content" ref={inspectionScroll}><div style={{ minHeight: inspectionHeight }}>
        {result.isFetching && result.isPlaceholderData ? <p>Loading…</p> : chartKind === "actions" ? <section aria-label="Action breakdown">
          {matchingActions.length ? matchingActions.slice(safeActionPage * 10, safeActionPage * 10 + 10).map(([name, amount], index) => <SeriesTooltipRow key={name} label={name} value={amount} color={bucket !== null && colorBy === "activity" ? CHART_PALETTE[safeActionPage * 10 + index] ?? "#94a3b8" : "#94a3b8"} />) : <p>No actions in this interval</p>}
          {matchingActions.length > 10 && <div className="inspection-pages"><button className="secondary" aria-label="Previous action types" disabled={!safeActionPage} onClick={() => { preserveInspectionHeight(); setActionPage(safeActionPage - 1); }}>Previous</button><small>{safeActionPage + 1} / {Math.ceil(matchingActions.length / 10)}</small><button className="secondary" aria-label="Next action types" disabled={(safeActionPage + 1) * 10 >= matchingActions.length} onClick={() => { preserveInspectionHeight(); setActionPage(safeActionPage + 1); }}>Next</button></div>}
        </section> : <>
          {chartKind === "messages" && <div className="inspection-roles">{MESSAGE_SERIES.map(s => <SeriesTooltipRow key={s.key} label={s.label} color={s.color} value={(data?.series ?? []).filter(r => bucket === null || r.time === bucket).reduce((n, r) => n + r[s.key], 0)} />)}</div>}
          {contributors.isPending ? <p>Loading sessions…</p> : contributors.error ? <p role="alert">{contributors.error.message}</p> : !contributors.data?.items.length ? <p>No sessions in this interval</p> : contributors.data.items.map(s => <button className="inspection-session" key={s.id} onClick={() => onOpenSession(s, narrow.get("q") ? "" : chartKind === "messages" ? "message" : "")}><span><strong>{s.title}</strong><small>{providerLabel(s.provider)}</small>{tokenMode && <small>Input {s.input_tokens == null ? "—" : `${s.tokens_partial ? "≥" : ""}${count(s.input_tokens)}`} · Output {s.output_tokens == null ? "—" : `${s.tokens_partial ? "≥" : ""}${count(s.output_tokens)}`}</small>}</span>{chartKind === "messages" && <b>{count(s.messages)}</b>}</button>)}
          {!!contributors.data && contributors.data.total > 5 && <div className="inspection-pages"><button className="secondary" aria-label="Previous contributors" disabled={!contributorOffset} onClick={() => { preserveInspectionHeight(); setContributorOffset(contributorOffset - 5); }}>Previous</button><small>{contributorOffset / 5 + 1} / {Math.ceil(contributors.data.total / 5)}</small><button className="secondary" aria-label="Next contributors" disabled={contributorOffset + 5 >= contributors.data.total} onClick={() => { preserveInspectionHeight(); setContributorOffset(contributorOffset + 5); }}>Next</button></div>}
        </>}
        </div></div>
      </>}
    </aside>
    </div>
  );
}
