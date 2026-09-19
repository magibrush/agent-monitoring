import { useRef, useState, type PointerEvent, type KeyboardEvent } from "react";
import type { Metrics } from "./api";

type Window = { start: number; end: number };
export function RangeNavigator({
  overview,
  viewport,
  interval,
  onChange,
  kind = "all",
}: {
  overview: Metrics;
  viewport: Metrics["viewport"];
  interval: number;
  onChange: (start: number, end: number) => void;
  kind?: "all" | "sessions" | "messages" | "actions" | "tokens";
}) {
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ mode: string; x: number; window: Window } | null>(
    null,
  );
  const [draft, setDraft] = useState<Window | null>(null);
  const min = Date.parse(overview.domain.start),
    max = Date.parse(overview.domain.end),
    span = Math.max(60000, max - min);
  const maxWidth = Math.min(span, interval ? interval * 600 * 1000 : span);
  const shown = draft ?? {
    start: Math.max(min, Date.parse(viewport.start)),
    end: Math.min(max, Date.parse(viewport.end)),
  };
  const percent = (value: number) => ((value - min) / span) * 100;
  function constrain(w: Window, mode: string): Window {
    if (mode === "start")
      return {
        start: Math.max(
          min,
          w.end - maxWidth,
          Math.min(w.start, w.end - 60000),
        ),
        end: w.end,
      };
    if (mode === "end")
      return {
        start: w.start,
        end: Math.min(
          max,
          w.start + maxWidth,
          Math.max(w.end, w.start + 60000),
        ),
      };
    const width = Math.min(maxWidth, Math.max(60000, w.end - w.start));
    const start = Math.max(min, Math.min(w.start, max - width));
    return { start, end: start + width };
  }
  function begin(e: PointerEvent, mode: string) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { mode, x: e.clientX, window: shown };
  }
  function move(e: PointerEvent) {
    const g = gesture.current;
    if (!g || !root.current) return;
    const delta =
      ((e.clientX - g.x) / root.current.getBoundingClientRect().width) * span;
    setDraft(
      constrain(
        {
          start: g.window.start + (g.mode !== "end" ? delta : 0),
          end: g.window.end + (g.mode !== "start" ? delta : 0),
        },
        g.mode,
      ),
    );
  }
  function finish() {
    if (draft) onChange(draft.start, draft.end);
    setDraft(null);
    gesture.current = null;
  }
  function key(e: KeyboardEvent, mode: string) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const step = Math.max(60000, span / 100) * (e.shiftKey ? 10 : 1);
    let w = { ...shown };
    const delta = e.key === "ArrowLeft" ? -step : step;
    if (mode === "start")
      w.start =
        e.key === "Home"
          ? min
          : e.key === "End"
            ? w.end - 60000
            : w.start + delta;
    else if (mode === "end")
      w.end =
        e.key === "End"
          ? max
          : e.key === "Home"
            ? w.start + 60000
            : w.end + delta;
    else {
      const width = w.end - w.start;
      w.start =
        e.key === "Home"
          ? min
          : e.key === "End"
            ? max - width
            : w.start + delta;
      w.end = w.start + width;
    }
    w = constrain(w, mode);
    onChange(w.start, w.end);
  }
  const rows = overview.series;
  const amount = (r: Metrics["series"][number]) => kind === "tokens" ? (r.input_tokens ?? 0) + (r.output_tokens ?? 0) : kind === "sessions" ? r.sessions ?? 0 : kind === "actions" ? r.actions : kind === "messages" ? r.user + r.assistant : r.actions + r.user + r.assistant;
  const peak = Math.max(
    1,
    ...rows.map((r) => Math.log10(1 + amount(r))),
  );
  const points = rows
    .map(
      (r) =>
        `${Math.max(0, Math.min(100, percent(r.time)))},${38 - (Math.log10(1 + amount(r)) / peak) * 33}`,
    )
    .join(" ");
  return (
    <div
      className="range-navigator"
      aria-label="Timeline overview"
      ref={root}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={() => {
        setDraft(null);
        gesture.current = null;
      }}
    >
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <polygon
          points={`0,40 ${points} 100,40`}
          fill="#dce3f1"
          stroke="#9fadc9"
          strokeWidth=".2"
        />
      </svg>
      <div
        className="navigator-shade"
        style={{ left: 0, width: `${percent(shown.start)}%` }}
      />
      <div
        className="navigator-shade"
        style={{ left: `${percent(shown.end)}%`, right: 0 }}
      />
      <div
        className="navigator-window"
        role="slider"
        tabIndex={0}
        aria-label="Move time window"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown.start}
        aria-valuetext={`${new Date(shown.start).toLocaleString()} to ${new Date(shown.end).toLocaleString()}`}
        style={{
          left: `${percent(shown.start)}%`,
          width: `${percent(shown.end) - percent(shown.start)}%`,
        }}
        onPointerDown={(e) => begin(e, "move")}
        onKeyDown={(e) => key(e, "move")}
      >
        {(["start", "end"] as const).map((mode) => (
          <div
            key={mode}
            className={`navigator-handle ${mode}`}
            role="slider"
            tabIndex={0}
            aria-label={`Range ${mode} handle`}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={shown[mode]}
            aria-valuetext={new Date(shown[mode]).toLocaleString()}
            title={new Date(shown[mode]).toLocaleString()}
            onPointerDown={(e) => begin(e, mode)}
            onKeyDown={(e) => {
              e.stopPropagation();
              key(e, mode);
            }}
          />
        ))}
      </div>
    </div>
  );
}
