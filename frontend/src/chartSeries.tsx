/** Shared categorical styling and cumulative stacking for count charts. */
// Alternate dark/cool and bright/warm accents so adjacent stack segments separate.
export const CHART_PALETTE = [
  "#2455a4", // blue
  "#ffad32", // amber
  "#663399", // purple
  "#55cfa2", // mint
  "#b51d45", // crimson
  "#52c9e8", // cyan
  "#75452b", // brown
  "#d9ca40", // yellow
  "#243747", // navy
  "#ec8ac0", // pink
] as const;
export const MESSAGE_SERIES = [
  { key: "user", label: "User", color: "#5069ba" },
  { key: "assistant", label: "Assistant", color: "#398678" },
] as const;
export const OTHER_COLOR = "#94a3b8";
export function categoricalSeries(tools: { name: string; count: number }[]) {
  const totals = new Map<string, number>();
  for (const tool of tools)
    totals.set(tool.name, (totals.get(tool.name) ?? 0) + tool.count);
  const ranked = [...totals]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const series = ranked.slice(0, 10).map(([name], index) => ({
    key: `series_${index}`,
    label: name,
    color: String(CHART_PALETTE[index]),
    members: [name],
  }));
  if (ranked.length > 10)
    series.push({
      key: "series_other",
      label: "Other actions",
      color: OTHER_COLOR,
      members: ranked.slice(10).map(([name]) => name),
    });
  return series;
}
export function cumulativeSegments(
  values: number[],
  transform: (n: number) => number,
) {
  let total = 0;
  return values.map((value) => {
    const before = transform(total);
    total += value;
    return transform(total) - before;
  });
}
export function ColorKey({ color }: { color: string }) {
  return (
    <i
      className="chart-color-key"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  );
}
export function SeriesTooltipRow({
  label,
  color,
  value,
  percent,
}: {
  label: string;
  color: string;
  value: number;
  percent?: number;
}) {
  return (
    <div className="tooltip-row">
      <span>
        <ColorKey color={color} />
        {label}
      </span>
      <strong>
        {value.toLocaleString()}
        {percent !== undefined && (
          <small className="tooltip-percent"> · {percent.toFixed(1)}%</small>
        )}
      </strong>
    </div>
  );
}
