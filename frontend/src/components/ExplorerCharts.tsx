import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtMoney } from "../format";

// Shared chart vocabulary for the Explorer's category sections. Every
// section renders the same two or three shapes (a ranked bar per model, a
// stacked outcome bar, a distribution histogram), so they live here once
// rather than as copy-pasted Recharts trees per panel.

export const RANKED_CHART_CAP = 10;
export const SERIES_SLOTS = 8;

export function seriesColor(i: number): string {
  return `var(--s${(i % SERIES_SLOTS) + 1})`;
}

export type MetricFmt = "ms" | "usd" | "pct" | "num" | "ratio";

export function fmtMetric(v: number | null | undefined, fmt: MetricFmt): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (fmt === "pct") return `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`;
  if (fmt === "ms") return `${Math.round(v).toLocaleString()} ms`;
  if (fmt === "usd") return fmtMoney(v);
  if (fmt === "ratio") return v.toFixed(2);
  return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

// ── stats helpers (shared with the page's own aggregation) ───────────────
export function quantileOf(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}
export function meanOf(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
export function stdevOf(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

// Recharts' category-axis ticks crop a too-long label from the left with no
// ellipsis (this axis is right-anchored) rather than shrinking or wrapping
// it. A native SVG <title> keeps the full alias reachable on hover.
function ModelAxisTick({ x, y, payload }: { x?: number; y?: number; payload?: { value?: string } }) {
  const name = payload?.value ?? "";
  const maxChars = 22;
  const display = name.length > maxChars ? `${name.slice(0, maxChars - 1)}…` : name;
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fontSize={11} fill="var(--ink-2)">
      <title>{name}</title>
      {display}
    </text>
  );
}

interface TipRow {
  label: string;
  value: string;
  color?: string;
}
function Tip({ head, rows }: { head: string; rows: TipRow[] }) {
  return (
    <div className="tip" style={{ opacity: 1, position: "static" }}>
      <div className="th">{head}</div>
      {rows.map((r) => (
        <div className="r" key={r.label}>
          <span>
            {r.color && <i style={{ background: r.color }} />}
            {r.label}
          </span>
          <span>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export interface RankedDatum {
  model_alias: string;
  value: number | null;
}

/**
 * One metric, one bar per model, sorted best-first by the caller. The
 * workhorse of every category section -- "who wins on this number" reads
 * instantly as bar length in a way a table column never does.
 */
export function RankedBar({
  title,
  data,
  fmt,
  valueLabel,
  domain,
  foldedCount,
  emptyHint,
  note,
  color = "var(--accent)",
}: {
  title: string;
  data: RankedDatum[];
  fmt: MetricFmt;
  valueLabel: string;
  domain?: [number, number];
  foldedCount?: number;
  emptyHint?: string;
  note?: string;
  color?: string;
}) {
  const usable = data.filter((d) => d.value !== null);
  return (
    <div>
      <span className="kicker">{title}</span>
      {usable.length === 0 ? (
        <p className="empty-hint">{emptyHint ?? "No data for this metric in the current scope."}</p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={Math.max(90, usable.length * 30)}>
            <BarChart data={usable} layout="vertical" margin={{ top: 6, right: 44, left: 0, bottom: 6 }}>
              <CartesianGrid stroke="var(--line)" horizontal={false} />
              <XAxis
                type="number"
                domain={domain}
                tickFormatter={(v: number) => fmtMetric(v, fmt)}
                tick={{ fontSize: 10.5, fill: "var(--muted)" }}
                axisLine={{ stroke: "var(--line-strong)" }}
                tickLine={false}
              />
              <YAxis type="category" dataKey="model_alias" tick={<ModelAxisTick />} axisLine={false} tickLine={false} width={160} />
              <Tooltip
                cursor={{ fill: "var(--surface-2)" }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload as RankedDatum;
                  return <Tip head={d.model_alias} rows={[{ label: valueLabel, value: fmtMetric(d.value, fmt), color }]} />;
                }}
              />
              <Bar dataKey="value" fill={color} radius={[0, 3, 3, 0]} barSize={16} />
            </BarChart>
          </ResponsiveContainer>
          {note && <p className="note">{note}</p>}
          {foldedCount ? (
            <p className="note">
              +{foldedCount} more not charted (past the top {RANKED_CHART_CAP}) — narrow the scope to compare them.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export interface OutcomeDatum {
  model_alias: string;
  pass: number;
  fail: number;
  error: number;
}

/**
 * Pass / fail / error counts per model as one stacked bar. Shows the shape
 * of a failure -- a model erroring out is a different problem from one
 * answering confidently and wrongly, and a single pass-rate number hides
 * which you have.
 */
export function OutcomeBar({ title, data }: { title: string; data: OutcomeDatum[] }) {
  const SERIES = [
    { key: "pass" as const, label: "passed", color: "var(--good)" },
    { key: "fail" as const, label: "failed", color: "var(--serious)" },
    { key: "error" as const, label: "errored", color: "var(--critical)" },
  ];
  return (
    <div>
      <span className="kicker">{title}</span>
      {data.length === 0 ? (
        <p className="empty-hint">No calls in the current scope.</p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={Math.max(90, data.length * 30)}>
            <BarChart data={data} layout="vertical" margin={{ top: 6, right: 20, left: 0, bottom: 6 }}>
              <CartesianGrid stroke="var(--line)" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 10.5, fill: "var(--muted)" }}
                axisLine={{ stroke: "var(--line-strong)" }}
                tickLine={false}
                allowDecimals={false}
              />
              <YAxis type="category" dataKey="model_alias" tick={<ModelAxisTick />} axisLine={false} tickLine={false} width={160} />
              <Tooltip
                cursor={{ fill: "var(--surface-2)" }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload as OutcomeDatum;
                  const total = d.pass + d.fail + d.error;
                  return (
                    <Tip
                      head={d.model_alias}
                      rows={[
                        ...SERIES.map((s) => ({ label: s.label, value: `${d[s.key]} of ${total}`, color: s.color })),
                      ]}
                    />
                  );
                }}
              />
              {SERIES.map((s) => (
                <Bar key={s.key} dataKey={s.key} stackId="outcome" name={s.label} fill={s.color} barSize={16} />
              ))}
            </BarChart>
          </ResponsiveContainer>
          <div className="chiprow" style={{ padding: "2px 0 0" }}>
            {SERIES.map((s) => (
              <span className="chip active" key={s.key} style={{ cursor: "default" }}>
                <span className="sw" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One bar per series within each category -- used for "this metric, per
 * model, per run", where the ranked single-metric bar would collapse the
 * run dimension away.
 */
export function GroupedBar({
  title,
  rows,
  categoryKey,
  series,
  fmt,
  domain,
  note,
  height = 260,
}: {
  title: string;
  rows: Record<string, string | number | null>[];
  categoryKey: string;
  series: { key: string; color: string }[];
  fmt: MetricFmt;
  domain?: [number, number];
  note?: string;
  height?: number;
}) {
  return (
    <div>
      <span className="kicker">{title}</span>
      {rows.length === 0 || series.length === 0 ? (
        <p className="empty-hint">Nothing in the current scope to chart.</p>
      ) : (
        <>
          <div className="chiprow" style={{ padding: "6px 0 4px" }}>
            {series.map((s) => (
              <span className="chip active" key={s.key} style={{ cursor: "default" }}>
                <span className="sw" style={{ background: s.color }} />
                {s.key}
              </span>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={height}>
            <BarChart data={rows} margin={{ top: 10, right: 8, left: 0, bottom: 6 }}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis
                dataKey={categoryKey}
                tick={{ fontSize: 10, fill: "var(--muted)" }}
                axisLine={{ stroke: "var(--line-strong)" }}
                tickLine={false}
                interval={0}
                angle={-20}
                textAnchor="end"
                height={54}
              />
              <YAxis
                domain={domain}
                tickFormatter={(v: number) => fmtMetric(v, fmt)}
                tick={{ fontSize: 10.5, fill: "var(--muted)" }}
                axisLine={false}
                tickLine={false}
                width={48}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <Tip
                      head={String(label)}
                      rows={payload.map((p) => ({
                        label: String(p.dataKey),
                        value: fmtMetric(p.value as number | null, fmt),
                        color: series.find((s) => s.key === p.dataKey)?.color,
                      }))}
                    />
                  );
                }}
              />
              {series.map((s) => (
                <Bar key={s.key} dataKey={s.key} name={s.key} fill={s.color} radius={[3, 3, 0, 0]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
          {note && <p className="note">{note}</p>}
        </>
      )}
    </div>
  );
}

/**
 * Distribution of one measure across every raw call in scope. A p95 tells
 * you the tail exists; the histogram tells you whether it's a handful of
 * outliers or a second hump, which is the difference between "retry it" and
 * "this model has two modes".
 */
export function Histogram({
  title,
  values,
  fmt,
  bins = 24,
  color = "var(--accent)",
}: {
  title: string;
  values: number[];
  fmt: MetricFmt;
  bins?: number;
  color?: string;
}) {
  const clean = values.filter((v) => Number.isFinite(v));
  let content;
  if (clean.length < 2) {
    content = <p className="empty-hint">Not enough calls in scope to show a distribution.</p>;
  } else {
    const min = Math.min(...clean);
    const max = Math.max(...clean);
    const width = (max - min) / bins || 1;
    const buckets = Array.from({ length: bins }, (_, i) => ({
      start: min + i * width,
      end: min + (i + 1) * width,
      count: 0,
    }));
    for (const v of clean) {
      const idx = Math.min(bins - 1, Math.floor((v - min) / width));
      buckets[idx].count += 1;
    }
    content = (
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={buckets} margin={{ top: 8, right: 8, left: 0, bottom: 6 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis
            dataKey="start"
            tickFormatter={(v: number) => fmtMetric(v, fmt)}
            tick={{ fontSize: 10, fill: "var(--muted)" }}
            axisLine={{ stroke: "var(--line-strong)" }}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            tick={{ fontSize: 10.5, fill: "var(--muted)" }}
            axisLine={false}
            tickLine={false}
            width={38}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as { start: number; end: number; count: number };
              return (
                <Tip
                  head={`${fmtMetric(d.start, fmt)} – ${fmtMetric(d.end, fmt)}`}
                  rows={[{ label: "calls", value: String(d.count), color }]}
                />
              );
            }}
          />
          <Bar dataKey="count" fill={color} radius={[2, 2, 0, 0]}>
            {buckets.map((_, i) => (
              <Cell key={i} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  }
  return (
    <div>
      <span className="kicker">{title}</span>
      {content}
    </div>
  );
}
