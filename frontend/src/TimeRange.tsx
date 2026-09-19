import { useEffect, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
export interface Range {
  start: string;
  end: string;
  label: string;
  lastSeconds?: number;
}
export const FIT: Range = { start: "", end: "", label: "All time" };
export const rangeQuery = (range: Range) => ({
  start: range.lastSeconds ? "" : range.start,
  end: range.lastSeconds ? "" : range.end,
  last_seconds: String(range.lastSeconds ?? 0),
});
const localValue = (value: string) => {
  if (!value) return "";
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
export function TimeRange({
  value,
  onChange,
}: {
  value: Range;
  onChange: (r: Range) => void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const [start, setStart] = useState(localValue(value.start)),
    [end, setEnd] = useState(localValue(value.end)),
    [error, setError] = useState("");
  useEffect(() => { setStart(localValue(value.start)); setEnd(localValue(value.end)); setError(""); }, [value.start, value.end]);
  function apply(range: Range) {
    onChange(range);
    setStart(localValue(range.start));
    setEnd(localValue(range.end));
    setError("");
    if (details.current) details.current.open = false;
  }
  function quick(label: string, hours: number) {
    const end = new Date();
    apply({
      start: new Date(end.getTime() - hours * 3600000).toISOString(),
      end: end.toISOString(),
      label,
      lastSeconds: hours * 3600,
    });
  }
  return (
    <details className="range-picker" ref={details} onToggle={() => {
      if (details.current?.open && value.lastSeconds) {
        const now = Date.now();
        setStart(localValue(new Date(now - value.lastSeconds * 1000).toISOString()));
        setEnd(localValue(new Date(now).toISOString()));
      }
    }}>
      <summary>
        <CalendarDays size={15} />
        <span
          title={
            value.lastSeconds ? `${value.label} · updates live` : value.start
              ? `${new Date(value.start).toLocaleString()} — ${new Date(value.end).toLocaleString()}`
              : "All recorded activity"
          }
        >
          Date:{" "}
          {value.label === "Custom range"
            ? `${new Date(value.start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} – ${new Date(value.end).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
            : value.label}
        </span>
      </summary>
      <div className="range-popover">
        <strong>Time range</strong>
        <div className="range-presets">
          <button className="secondary" onClick={() => apply(FIT)}>
            All time
          </button>
          {[
            ["Last hour", 1],
            ["Last 24 hours", 24],
            ["Last 7 days", 168],
            ["Last 30 days", 720],
            ["Last year", 8760],
          ].map(([name, h]) => (
            <button
              key={name}
              className="secondary"
              onClick={() => quick(String(name), Number(h))}
            >
              {name}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const a = new Date(start),
              b = new Date(end);
            if (
              !Number.isFinite(a.getTime()) ||
              !Number.isFinite(b.getTime()) ||
              a >= b
            ) {
              setError("Choose an end after the start.");
              return;
            }
            apply({
              start: a.toISOString(),
              end: b.toISOString(),
              label: "Custom range",
            });
          }}
        >
          <label className="field">
            From
            <input
              aria-label="Range start"
              type="datetime-local"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label className="field">
            To
            <input
              aria-label="Range end"
              type="datetime-local"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary">Apply range</button>
        </form>
      </div>
    </details>
  );
}
