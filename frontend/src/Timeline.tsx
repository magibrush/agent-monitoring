import { useEffect, useState } from "react";
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
import { api, type Metrics, type Session } from "./api";
import { Conversation } from "./Conversation";
import { Modal } from "./ui";
import {
  categoricalSeries,
  cumulativeSegments,
  MESSAGE_SERIES,
  ColorKey,
  SeriesTooltipRow,
} from "./chartSeries";
import { RangeNavigator } from "./RangeNavigator";

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

export function Timeline({ params }: { params: string }) {
  const [viewport, setViewport] = useState<{
    start: string;
    end: string;
  } | null>(null);
  const [interval, setInterval] = useState("0");
  const [scale, setScale] = useState("log");
  const [bucket, setBucket] = useState<number | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [lane, setLane] = useState("actions");
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const [contributorOffset, setContributorOffset] = useState(0);
  const [opened, setOpened] = useState<Session | null>(null);
  const query = new URLSearchParams(params);
  query.set("interval", interval);
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
      bucket === null ? data.viewport.start : new Date(bucket).toISOString(),
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
    enabled: Boolean(data) && inspecting,
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
  const transform = (n: number) => (scale === "log" ? Math.log10(1 + n) : n);
  const actionSeries = categoricalSeries("tools", [
    ...new Set(
      [...(overview.data?.series ?? []), ...(data?.series ?? [])].flatMap((r) =>
        r.tools.map((t) => t.name),
      ),
    ),
  ]);
  const rows =
    data?.series.map((r) => {
      const parts = cumulativeSegments(
        actionSeries.map((series) =>
          r.tools
            .filter((t) => series.members.includes(t.name))
            .reduce((sum, t) => sum + t.count, 0),
        ),
        transform,
      );
      return {
        ...r,
        plotUser: transform(r.user),
        plotAssistant: transform(r.user + r.assistant) - transform(r.user),
        ...Object.fromEntries(
          actionSeries.map((series, i) => [series.key, parts[i]]),
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
              domain={scale === "log" ? [0, transform(maxLog)] : [0, "auto"]}
              ticks={
                scale === "log"
                  ? rawTicks.filter((v) => v <= maxLog).map(transform)
                  : undefined
              }
              tickFormatter={(v) =>
                count(
                  scale === "log" ? Math.round(10 ** Number(v) - 1) : Number(v),
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
                  <div className="signal-tooltip">
                    <strong>
                      {date(r.time)} —{" "}
                      {date(
                        Math.min(
                          Date.parse(data.viewport.end),
                          r.time + data.interval_seconds * 1000,
                        ),
                      )}
                    </strong>

                    {kind === "actions" ? (
                      <>
                        <b>{count(r.actions)} actions</b>
                        {r.tools?.map((t: { name: string; count: number }) => (
                          <SeriesTooltipRow
                            key={t.name}
                            label={t.name}
                            color={
                              actionSeries.find((s) =>
                                s.members.includes(t.name),
                              )?.color ?? "#667789"
                            }
                            value={t.count}
                          />
                        ))}
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
                  </div>
                );
              }}
            />
            {kind === "actions" ? (
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
    <section className="panel timeline-panel signals-panel">
      <div className="chart-toolbar">
        {" "}
        <div className="signal-settings">
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
          <label>
            Scale{" "}
            <select
              aria-label="Vertical scale"
              title="Logarithmic scale preserves zero counts; hover for exact values"
              value={scale}
              onChange={(e) => setScale(e.target.value)}
            >
              <option value="log">Logarithmic</option>
              <option value="linear">Linear</option>
            </select>
          </label>
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
            <button
              className="secondary"
              aria-label="Inspect activity"
              aria-expanded={inspecting}
              onClick={() => setInspecting(!inspecting)}
            >
              Inspect
            </button>
          </div>
        )}{" "}
      </div>{" "}
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
            className={`investigation-grid ${inspecting ? "with-inspector" : ""}`}
          >
            <div className="signal-charts">
              <div className="signal-heading">
                <h3>Actions</h3>
              </div>
              {plot("actions")}
              <div className="signal-heading">
                <h3>Messages</h3>
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
              </div>
              {plot("messages")}
              {overview.data && (
                <RangeNavigator
                  overview={overview.data}
                  viewport={data.viewport}
                  interval={Number(interval)}
                  onChange={windowTo}
                />
              )}
            </div>
            {inspecting && (
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
                {contributors.data?.items.map((s) => (
                  <button
                    className="contributor"
                    key={s.id}
                    onClick={() => setOpened(s)}
                  >
                    <strong>{s.title}</strong>
                    <span>
                      {count(s.actions)} actions · {count(s.messages)} messages
                    </span>
                  </button>
                ))}
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
