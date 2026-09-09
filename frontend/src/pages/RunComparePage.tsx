import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useCompareRuns } from "../api/hooks";
import { fmtDate, fmtVal } from "../format";
import type { ChartFmt, RunCompareOut } from "../api/types";

// Same --sN slot-color convention as the Dashboard's trend chart: color
// follows the model alias, stable regardless of which runs are in view.
const SLOTS = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];

function runLabel(r: RunCompareOut): string {
  return `${fmtDate(r.created_at)} · ${r.run_id.slice(-6)}`;
}

const METRICS: { key: string; title: string; fmt: ChartFmt }[] = [
  { key: "pass_rate", title: "Pass rate", fmt: "pct" },
  { key: "latency_ms_p95", title: "Latency p95", fmt: "ms" },
  { key: "cost_per_success", title: "Cost per success", fmt: "usd" },
];

export default function RunComparePage() {
  const [params, setParams] = useSearchParams();
  const ids = useMemo(() => (params.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean), [params]);
  const { data: runs, isLoading, error } = useCompareRuns(ids);

  function removeRun(runId: string) {
    const remaining = ids.filter((i) => i !== runId);
    setParams(remaining.length ? { ids: remaining.join(",") } : {});
  }

  const completed = (runs ?? []).filter((r) => r.status === "completed" && r.summary.length > 0);
  const incomplete = (runs ?? []).filter((r) => !(r.status === "completed" && r.summary.length > 0));

  const aliases = useMemo(
    () => Array.from(new Set(completed.flatMap((r) => r.summary.map((s) => s.model_alias)))),
    [completed]
  );
  const colorFor = (alias: string) => `var(${SLOTS[aliases.indexOf(alias) % SLOTS.length]})`;

  const rows = useMemo(
    () =>
      completed.map((r) => {
        const row: Record<string, string | number | null> = { run: runLabel(r), fullRunId: r.run_id };
        for (const s of r.summary) {
          for (const m of METRICS) row[`${s.model_alias}__${m.key}`] = (s as unknown as Record<string, number | null>)[m.key];
        }
        return row;
      }),
    [completed]
  );

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Compare runs</h1>
          <p>Same metric, side by side by run — grouped by model so a regression shows up as one bar moving, not a table you have to scan.</p>
        </div>
        <Link className="btn ghost" to="/runs">
          ← All runs
        </Link>
      </div>
      <div className="content">
        {ids.length === 0 && <p className="empty-hint">No runs selected — go to Runs, check the boxes you want, then Compare.</p>}
        {isLoading && ids.length > 0 && <p className="empty-hint">Loading…</p>}
        {error && <p className="empty-hint">Couldn't load one or more of these runs — they may have been removed.</p>}

        {runs && runs.length > 0 && (
          <div className="panel" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "14px 18px" }}>
              {runs.map((r) => (
                <span className="tag" key={r.run_id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Link to={`/runs/${r.run_id}`} className="mono" style={{ color: "inherit" }}>
                    {runLabel(r)}
                  </Link>
                  {r.status !== "completed" && <em style={{ color: "var(--muted)", fontStyle: "normal" }}>({r.status})</em>}
                  <span role="button" aria-label={`Remove ${r.run_id}`} style={{ opacity: 0.6, cursor: "pointer" }} onClick={() => removeRun(r.run_id)}>
                    ×
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}

        {incomplete.length > 0 && (
          <p className="note">
            {incomplete.length} of {runs?.length ?? 0} selected run(s) {incomplete.length === 1 ? "has" : "have"} no
            data to chart yet (not completed, or empty) — excluded below: {incomplete.map((r) => r.run_id).join(", ")}.
          </p>
        )}

        {completed.length > 0 && (
          <div className="panel">
            <div className="panel-head">
              <h2>Metrics by run</h2>
              <span className="sub">One bar per model per run — hover for the exact value</span>
            </div>
            <div className="chiprow" style={{ padding: "0 18px 12px" }}>
              {aliases.map((a) => (
                <span className="chip active" key={a}>
                  <span className="sw" style={{ background: colorFor(a) }} />
                  {a}
                </span>
              ))}
            </div>
            {METRICS.map((m) => (
              <div key={m.key} style={{ padding: "4px 18px 20px" }}>
                <span className="kicker">{m.title}</span>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={rows} margin={{ top: 10, right: 8, left: 0, bottom: 6 }}>
                    <CartesianGrid stroke="var(--line)" vertical={false} />
                    <XAxis
                      dataKey="run"
                      tick={{ fontSize: 10.5, fill: "var(--muted)" }}
                      axisLine={{ stroke: "var(--line-strong)" }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 10.5, fill: "var(--muted)" }}
                      axisLine={false}
                      tickLine={false}
                      width={52}
                      tickFormatter={(v: number) => fmtVal(v, m.fmt)}
                    />
                    <Tooltip content={<CompareTooltip fmt={m.fmt} aliases={aliases} metric={m.key} colorFor={colorFor} />} />
                    {aliases.map((a) => (
                      <Bar key={a} dataKey={`${a}__${m.key}`} name={a} fill={colorFor(a)} radius={[3, 3, 0, 0]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

interface TooltipPayload {
  dataKey: string;
  value: number | null;
}

function CompareTooltip({
  active,
  payload,
  label,
  fmt,
  aliases,
  metric,
  colorFor,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
  fmt: ChartFmt;
  aliases: string[];
  metric: string;
  colorFor: (alias: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tip" style={{ opacity: 1, position: "static" }}>
      <div className="th">{label}</div>
      {aliases.map((a) => {
        const entry = payload.find((p) => p.dataKey === `${a}__${metric}`);
        if (!entry) return null;
        return (
          <div className="r" key={a}>
            <span>
              <i style={{ background: colorFor(a) }} />
              {a}
            </span>
            <span>{fmtVal(entry.value, fmt)}</span>
          </div>
        );
      })}
    </div>
  );
}
