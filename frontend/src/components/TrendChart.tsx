import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartConfig, ChartFmt } from "../api/types";
import { fmtVal } from "../format";

export default function TrendChart({
  config,
  colorFor,
  activeAliases,
}: {
  config: ChartConfig;
  colorFor: (alias: string) => string;
  activeAliases: string[];
}) {
  const rows = config.data.labels.map((label, i) => {
    const row: Record<string, string | number | null> = { label };
    config.data.series.forEach((s) => {
      row[s.name] = s.values[i];
    });
    return row;
  });

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={rows} margin={{ top: 10, right: 90, left: 4, bottom: 6 }}>
        <CartesianGrid stroke="var(--line)" vertical={false} />
        <XAxis
          dataKey="label"
          tickFormatter={(l: string) => l.slice(5)}
          tick={{ fontSize: 10.5, fill: "var(--muted)" }}
          axisLine={{ stroke: "var(--line-strong)" }}
          tickLine={false}
        />
        <YAxis
          tickFormatter={(v: number) => fmtVal(v, config.fmt)}
          tick={{ fontSize: 10.5, fill: "var(--muted)" }}
          axisLine={false}
          tickLine={false}
          width={56}
          domain={["auto", "auto"]}
        />
        <Tooltip content={<ChartTooltip fmt={config.fmt} colorFor={colorFor} />} />
        {config.threshold !== null && config.threshold !== undefined && (
          <ReferenceLine
            y={config.threshold}
            stroke="var(--muted)"
            strokeDasharray="5 4"
            label={{
              value: `target ${fmtVal(config.threshold, config.fmt)}`,
              position: "insideTopLeft",
              fill: "var(--muted)",
              fontSize: 10.5,
            }}
          />
        )}
        {config.data.series
          .filter((s) => activeAliases.includes(s.name))
          .map((s) => (
            <Line
              key={s.name}
              type="monotone"
              dataKey={s.name}
              stroke={colorFor(s.name)}
              strokeWidth={2}
              dot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
              connectNulls
              activeDot={{ r: 5 }}
              name={s.name}
            />
          ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

interface TooltipEntry {
  dataKey: string;
  value: number | null;
}

function ChartTooltip({
  active,
  payload,
  label,
  fmt,
  colorFor,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
  fmt: ChartFmt;
  colorFor: (alias: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tip" style={{ opacity: 1, position: "static" }}>
      <div className="th">{label}</div>
      {payload.map((p) => (
        <div className="r" key={p.dataKey}>
          <span>
            <i style={{ background: colorFor(p.dataKey) }} />
            {p.dataKey}
          </span>
          <span>{fmtVal(p.value, fmt)}</span>
        </div>
      ))}
    </div>
  );
}
