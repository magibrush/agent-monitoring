/** Shared categorical styling and cumulative stacking for count charts. */
export const CHART_PALETTE = [
  "#5069ba",
  "#398678",
  "#b77c38",
  "#9562b5",
  "#bc5863",
  "#368ca5",
  "#86843d",
  "#bb6e9c",
  "#667789",
  "#96644b",
] as const;
export const MESSAGE_SERIES = [
  { key: "user", label: "User", color: CHART_PALETTE[0] },
  { key: "assistant", label: "Assistant", color: CHART_PALETTE[1] },
] as const;
const registries = new Map<string, string[]>();
export function categoricalSeries(namespace: string, names: string[]) {
  let known = registries.get(namespace);
  if (!known) {
    try {
      const saved = JSON.parse(
        localStorage.getItem(`relay.chart.${namespace}`) || "[]",
      );
      known = Array.isArray(saved)
        ? saved.filter((n: unknown) => typeof n === "string")
        : [];
    } catch {
      known = [];
    }
    registries.set(namespace, known!);
  }
  for (const name of [...new Set(names)].sort())
    if (!known!.includes(name)) known!.push(name);
  try {
    localStorage.setItem(`relay.chart.${namespace}`, JSON.stringify(known));
  } catch {
    /* Storage can be disabled. In-memory assignments remain stable. */
  }
  const groups = new Map<
    string,
    { key: string; label: string; color: string; members: string[] }
  >();
  for (const name of [...new Set(names)].sort(
    (a, b) => known!.indexOf(a) - known!.indexOf(b),
  )) {
    const index = known!.indexOf(name),
      overflow = index >= 9;
    const key = overflow ? "series_other" : `series_${index}`;
    if (!groups.has(key))
      groups.set(key, {
        key,
        label: overflow ? "Other tools" : name,
        color: CHART_PALETTE[overflow ? 9 : index],
        members: [],
      });
    groups.get(key)!.members.push(name);
  }
  return [...groups.values()];
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
}: {
  label: string;
  color: string;
  value: number;
}) {
  return (
    <div className="tooltip-row">
      <span>
        <ColorKey color={color} />
        {label}
      </span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}
