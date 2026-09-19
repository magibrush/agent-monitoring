import { useEffect, useState, type ReactNode, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { api, type Metrics } from "./api";

const intervals = [[60, "1 minute"], [300, "5 minutes"], [900, "15 minutes"], [3600, "1 hour"], [21600, "6 hours"], [86400, "1 day"], [604800, "1 week"], [2592000, "30 days"], [31536000, "1 year"]] as const;

/** One time-window model for Overview and Safety. Filters define the full scope;
 * dragging, zooming and interval changes only change its visible window. */
export function useTimeChart(params: string, conversations = false, onViewportChange?: (viewport: Metrics["viewport"] | null) => void) {
  const [viewport, setViewport] = useState<Metrics["viewport"] | null>(null);
  const [interval, setInterval] = useState("0");
  const [bucket, setBucket] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  useEffect(() => { setViewport(null); setBucket(null); setDrag(null); }, [params]);
  const query = new URLSearchParams(params);
  query.set("interval", interval); query.set("conversations", String(conversations));
  if (viewport) { query.set("view_start", viewport.start); query.set("view_end", viewport.end); }
  const result = useQuery({ queryKey: ["timeline", query.toString()], queryFn: () => api<Metrics>(`/metrics?${query}`), placeholderData: previous => previous });
  const overview = useQuery({ queryKey: ["metrics", params], queryFn: () => api<Metrics>(`/metrics?${params}`) });
  const data = result.data;
  const zoomed = Boolean(data && (Math.abs(Date.parse(data.viewport.start) - Date.parse(data.domain.start)) > 1 || Math.abs(Date.parse(data.viewport.end) - Date.parse(data.domain.end)) > 1));
  const canZoomOut = Boolean(data && zoomed && (interval === "0" || Date.parse(data.viewport.end) - Date.parse(data.viewport.start) < Number(interval) * 600000));
  function onContextMenu(event: MouseEvent) {
    event.preventDefault();
    setDrag(null);
    if (canZoomOut) change(2);
  }
  useEffect(() => {
    if (data && !result.isPlaceholderData) onViewportChange?.(zoomed ? data.viewport : null);
  }, [data?.viewport.start, data?.viewport.end, zoomed, result.isPlaceholderData, onViewportChange]);
  function windowTo(low: number, high: number) {
    if (!data) return;
    const min = Date.parse(data.domain.start), max = Date.parse(data.domain.end);
    const width = Math.min(max - min, interval === "0" ? Infinity : Number(interval) * 600000, Math.max(60000, high - low));
    low = Math.max(min, Math.min(low, max - width));
    setViewport({ start: new Date(low).toISOString(), end: new Date(low + width).toISOString() }); setBucket(null); setDrag(null);
  }
  function change(factor: number, direction = 0) {
    if (!data) return;
    const low = Date.parse(data.viewport.start), high = Date.parse(data.viewport.end), width = high - low;
    const center = (low + high) / 2 + direction * width * .8;
    windowTo(center - width * factor / 2, center + width * factor / 2);
  }
  function reset() { setViewport(null); setInterval("0"); setBucket(null); setDrag(null); }
  function finishDrag(onBucket?: () => void) {
    if (!drag || !data) return;
    const { start, end } = drag; setDrag(null);
    if (start === end) { setBucket(start); onBucket?.(); }
    else windowTo(Math.min(start, end), Math.max(start, end) + data.interval_seconds * 1000);
  }
  const narrow = new URLSearchParams(params);
  if (data) {
    narrow.set("start", bucket === null ? data.viewport.start : new Date(Math.max(bucket, Date.parse(data.viewport.start))).toISOString());
    narrow.set("end", bucket === null ? data.viewport.end : new Date(Math.min(bucket + data.interval_seconds * 1000, Date.parse(data.viewport.end))).toISOString());
  }
  return { result, overview, data, viewport, interval, setInterval, bucket, setBucket, drag, setDrag, finishDrag, windowTo, change, reset, zoomed, narrow, canZoomOut, onContextMenu };
}
export type TimeChartState = ReturnType<typeof useTimeChart>;

export function TimeChartControls({ chart, children }: { chart: TimeChartState; children?: ReactNode }) {
  const { data, interval, setInterval, setBucket, change, reset, zoomed } = chart;
  return <div className="time-chart-controls"><div className="time-chart-options">{children}<label>Interval <select aria-label="Bucket size" value={interval} onChange={e => { setInterval(e.target.value); setBucket(null); }}><option value="0">Auto{data ? ` · ${data.interval_label}` : ""}</option>{intervals.map(([v, text]) => <option key={v} value={v}>{text}</option>)}</select></label></div>
    <div className="time-chart-navigation">
      <button aria-label="Pan earlier" title="Earlier" disabled={!data || Date.parse(data.viewport.start) <= Date.parse(data.domain.start)} onClick={() => change(1, -1)}><ChevronLeft size={16} /></button>
      <button aria-label="Zoom in" title="Zoom in" disabled={!data || Date.parse(data.viewport.end) - Date.parse(data.viewport.start) <= 60000} onClick={() => change(.5)}><ZoomIn size={16} /></button>
      <button aria-label="Zoom out" title="Zoom out" disabled={!chart.canZoomOut} onClick={() => change(2)}><ZoomOut size={16} /></button>
      <button aria-label="Pan later" title="Later" disabled={!data || Date.parse(data.viewport.end) >= Date.parse(data.domain.end)} onClick={() => change(1, 1)}><ChevronRight size={16} /></button>
      <button aria-label="Reset zoom" disabled={!zoomed && interval === "0"} onClick={reset}><Maximize2 size={14} />Reset</button>
    </div>
  </div>;
}

export function TimeChartCaption({ chart }: { chart: TimeChartState }) {
  const data = chart.data;
  return <div className="time-chart-caption window-caption"><span>{data ? `${new Date(data.viewport.start).toLocaleString()} — ${new Date(data.viewport.end).toLocaleString()}` : "Loading timeline…"}{data?.window_limited && " · 600-bucket window"}</span><span>Drag to zoom · click a bar to inspect</span></div>;
}
