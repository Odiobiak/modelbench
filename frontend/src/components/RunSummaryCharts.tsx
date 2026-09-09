import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RunSummaryRow } from "../api/types";
import { fmtVal } from "../format";

// Grouped/single-series bar charts, built from bench/report.py's summarize()
// output (RunResultsOut.summary) -- percentiles and cost-per-success are
// computed once per run and were sitting unused; this is the first place
// that renders them. Deliberately a different chart shape (bars, categorical
// by model) from the Dashboard's line-over-time trend and table heatmap, so
// "how did this run's models compare" reads at a glance instead of as rows
// of numbers.

const LATENCY_SERIES: { key: string; label: string; color: string }[] = [
  { key: "latency_ms_p50", label: "p50", color: "var(--s1)" },
  { key: "latency_ms_p90", label: "p90", color: "var(--s4)" },
  { key: "latency_ms_p95", label: "p95", color: "var(--s2)" },
  { key: "latency_ms_p99", label: "p99", color: "var(--s8)" },
];

function shortModel(alias: string): string {
  return alias.length > 16 ? alias.slice(0, 15) + "…" : alias;
}

export default function RunSummaryCharts({ summary }: { summary: RunSummaryRow[] }) {
  const latencyRows = summary.map((r) => ({
    model: shortModel(r.model_alias),
    fullModel: r.model_alias,
    latency_ms_p50: r.latency_ms_p50,
    latency_ms_p90: r.latency_ms_p90,
    latency_ms_p95: r.latency_ms_p95,
    latency_ms_p99: r.latency_ms_p99,
  }));
  const costRows = summary.map((r) => ({
    model: shortModel(r.model_alias),
    fullModel: r.model_alias,
    cost_per_success: r.cost_per_success,
  }));

  const axisProps = {
    dataKey: "model",
    tick: { fontSize: 10, fill: "var(--muted)" },
    axisLine: { stroke: "var(--line-strong)" },
    tickLine: false,
    interval: 0 as const,
    angle: -25,
    textAnchor: "end" as const,
    height: 46,
  };

  return (
    <div className="grid2" style={{ padding: "16px 18px", gap: 20 }}>
      <div>
        <span className="kicker">Latency percentiles, this run (ms)</span>
        <ResponsiveContainer width="100%" height={230}>
          <BarChart data={latencyRows} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis {...axisProps} />
            <YAxis
              tick={{ fontSize: 10.5, fill: "var(--muted)" }}
              axisLine={false}
              tickLine={false}
              width={44}
              tickFormatter={(v: number) => fmtVal(v, "ms")}
            />
            <Tooltip content={<BarTooltip fmt="ms" series={LATENCY_SERIES} />} />
            {LATENCY_SERIES.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[3, 3, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div>
        <span className="kicker">Cost per success, this run ($)</span>
        <ResponsiveContainer width="100%" height={230}>
          <BarChart data={costRows} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis {...axisProps} />
            <YAxis
              tick={{ fontSize: 10.5, fill: "var(--muted)" }}
              axisLine={false}
              tickLine={false}
              width={56}
              tickFormatter={(v: number) => fmtVal(v, "usd")}
            />
            <Tooltip content={<BarTooltip fmt="usd" series={[{ key: "cost_per_success", label: "cost/success", color: "var(--s3)" }]} />} />
            <Bar dataKey="cost_per_success" name="cost/success" fill="var(--s3)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface BarTooltipPayload {
  dataKey: string;
  value: number | null;
  payload: { fullModel: string };
}

function BarTooltip({
  active,
  payload,
  fmt,
  series,
}: {
  active?: boolean;
  payload?: BarTooltipPayload[];
  fmt: "ms" | "usd";
  series: { key: string; label: string; color: string }[];
}) {
  if (!active || !payload?.length) return null;
  const byKey = new Map(series.map((s) => [s.key, s]));
  return (
    <div className="tip" style={{ opacity: 1, position: "static" }}>
      <div className="th">{payload[0].payload.fullModel}</div>
      {payload.map((p) => {
        const s = byKey.get(p.dataKey);
        return (
          <div className="r" key={p.dataKey}>
            <span>
              <i style={{ background: s?.color }} />
              {s?.label ?? p.dataKey}
            </span>
            <span>{fmtVal(p.value, fmt)}</span>
          </div>
        );
      })}
    </div>
  );
}
