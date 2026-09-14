import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import StatTile from "../components/StatTile";
import DriftTable from "../components/DriftTable";
import TrendChart from "../components/TrendChart";
import CollapsiblePanel from "../components/CollapsiblePanel";
import { useDashboard, useRuns } from "../api/hooks";
import { fmtDate, fmtMoney } from "../format";
import type { ChartConfig } from "../api/types";

const METRICS: { key: "pass" | "ttft" | "cost" | "cache"; label: string }[] = [
  { key: "pass", label: "Pass rate" },
  { key: "ttft", label: "TTFT p95" },
  { key: "cost", label: "Cost / success" },
  { key: "cache", label: "Cache hit ratio" },
];

const SLOTS = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];

export default function DashboardPage() {
  const navigate = useNavigate();
  const { data: runs } = useRuns();
  const [chosenModels, setChosenModels] = useState<string[] | null>(null);
  const { data, isLoading, error } = useDashboard(chosenModels ?? undefined);
  const [metric, setMetric] = useState<"pass" | "ttft" | "cost" | "cache">("pass");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [matrixSort, setMatrixSort] = useState<{ col: "model" | number; dir: "asc" | "desc" } | null>(null);

  // Fixed hue-order assignment, stable regardless of which chips are toggled --
  // color follows the entity, never its rank in the currently visible set.
  const aliases = useMemo(() => data?.charts.pass.data.series.map((s) => s.name) ?? [], [data]);
  const colorFor = (alias: string) => {
    const i = aliases.indexOf(alias);
    return `var(${SLOTS[i % SLOTS.length]})`;
  };

  function addModel(alias: string) {
    const current = chosenModels ?? aliases;
    if (current.includes(alias)) return;
    setChosenModels([...current, alias]);
  }
  function removeModel(alias: string) {
    const current = chosenModels ?? aliases;
    setChosenModels(current.filter((a) => a !== alias));
  }

  const config: ChartConfig | undefined = data?.charts[metric];
  const activeAliases = aliases.filter((a) => !hidden.has(a));

  const sortedMatrix = useMemo(() => {
    const rows = data?.matrix ?? [];
    if (!matrixSort) return rows;
    const { col, dir } = matrixSort;
    const sorted = [...rows].sort((a, b) => {
      if (col === "model") return a.model.localeCompare(b.model);
      const av = a.cells[col];
      const bv = b.cells[col];
      if (av === null) return bv === null ? 0 : 1;
      if (bv === null) return -1;
      return av - bv;
    });
    if (dir === "desc") sorted.reverse();
    return sorted;
  }, [data?.matrix, matrixSort]);

  function toggleMatrixSort(col: "model" | number) {
    setMatrixSort((prev) => {
      if (prev && prev.col === col) return { col, dir: prev.dir === "asc" ? "desc" : "asc" };
      return { col, dir: "desc" };
    });
  }
  function matrixSortArrow(col: "model" | number) {
    if (!matrixSort || matrixSort.col !== col) return "";
    return matrixSort.dir === "asc" ? " ▲" : " ▼";
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Dashboard</h1>
          <p>
            The scorecard says which model is best today. This says what changed, and when — drift is measured
            against the median of the previous four runs, not the single last one, so a noisy single run can't
            trigger a false alarm.
            {data && (
              <>
                {" "}
                Built from <strong>{data.meta.calls}</strong> calls across <strong>{data.meta.runs}</strong> run
                {data.meta.runs === 1 ? "" : "s"} and <strong>{data.meta.models}</strong> model
                {data.meta.models === 1 ? "" : "s"}, spanning {data.meta.days} day{data.meta.days === 1 ? "" : "s"}.
              </>
            )}
          </p>
        </div>
        {runs && runs.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) navigate(`/runs/${e.target.value}`);
            }}
            style={{ width: "auto" }}
          >
            <option value="">Jump to a run…</option>
            {runs.map((r) => (
              <option key={r.run_id} value={r.run_id}>
                {fmtDate(r.created_at)} · {r.run_id} · {r.status}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="content">
        {isLoading && <p className="empty-hint">Loading…</p>}
        {error && (
          <p className="empty-hint">
            No results found yet. Launch a run from the Launch run page, then come back here.
          </p>
        )}
        {data && (
          <>
            <div className="tiles">
              <StatTile
                label="Drift alerts"
                value={String(data.tiles.drift_alerts)}
                sub="needing attention"
                alarm={data.tiles.drift_alerts > 0}
                hint="A model's latest run moved meaningfully against the median of its own previous 4 runs. See the table below for which metric and by how much."
              />
              <StatTile
                label="Version changes"
                value={String(data.tiles.version_changes)}
                sub="alias pointed elsewhere"
                hint="How many times a model alias started resolving to a different underlying served version — a silent vendor-side swap, not something you configured."
              />
              <StatTile
                label="Best pass rate"
                value={data.tiles.best_pass_rate ? `${(data.tiles.best_pass_rate.value * 100).toFixed(0)}%` : "—"}
                sub={data.tiles.best_pass_rate?.model ?? "—"}
                hint="Highest overall pass rate across every pack combined — check the pack heatmap below before trusting this for a specific use case."
              />
              <StatTile
                label="Cheapest / success"
                value={data.tiles.cheapest_per_success ? fmtMoney(data.tiles.cheapest_per_success.value) : "—"}
                sub={data.tiles.cheapest_per_success?.model ?? "—"}
                hint="Total spend divided by cases actually passed, not raw price — a cheap model that fails often can cost more per success than an expensive one that doesn't."
              />
              <StatTile
                label="Latency basis"
                value={data.tiles.latency_authoritative ? "Absolute" : "Relative"}
                sub={data.tiles.latency_authoritative ? "direct vendor routes" : "gateway hop included"}
                hint="Absolute: every model in this run went over a direct vendor route, so latency numbers are real wall-clock time. Relative: at least one went through a gateway, adding a hop — fine for comparing models within this run, not for citing as an absolute number."
              />
            </div>

            <CollapsiblePanel
              id="dashboard-drift"
              title="Drift vs. baseline"
              sub="Last run vs. median of the previous 4 — click a row to isolate that model in the trend chart below"
              defaultCollapsed={data.alerts.length === 0}
              style={{ marginBottom: 16 }}
            >
              <div className="tablewrap">
                <DriftTable alerts={data.alerts} onSelect={(model) => setHidden(new Set(aliases.filter((a) => a !== model)))} />
              </div>
            </CollapsiblePanel>

            <CollapsiblePanel
              id="dashboard-trend"
              title="Trend explorer"
              sub={`${config?.sub ?? ""} Click a model chip to hide/show its line, or × to drop it from the chart entirely.`}
              style={{ marginBottom: 16 }}
            >
              <div className="metrictabs">
                {METRICS.map((m) => (
                  <button
                    key={m.key}
                    className={`metrictab${metric === m.key ? " active" : ""}`}
                    onClick={() => setMetric(m.key)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="chiprow" style={{ alignItems: "center" }}>
                {aliases.map((alias) => (
                  <button
                    key={alias}
                    className={`chip${!hidden.has(alias) ? " active" : ""}`}
                    title="Click to show/hide. Use the × to drop it from the chart entirely."
                    onClick={() => {
                      const next = new Set(hidden);
                      if (next.has(alias)) next.delete(alias);
                      else next.add(alias);
                      setHidden(next);
                    }}
                  >
                    <span className="sw" style={{ background: !hidden.has(alias) ? colorFor(alias) : undefined }} />
                    {alias}
                    <span
                      role="button"
                      aria-label={`Remove ${alias} from chart`}
                      style={{ marginLeft: 2, opacity: 0.6 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeModel(alias);
                      }}
                    >
                      ×
                    </span>
                  </button>
                ))}
                {data.meta.folded_models.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) addModel(e.target.value);
                    }}
                    style={{ width: "auto", fontSize: 12, padding: "5px 8px" }}
                  >
                    <option value="">+ Add model to chart…</option>
                    {data.meta.folded_models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="chartcard">
                {config && <TrendChart config={config} colorFor={colorFor} activeAliases={activeAliases} />}
              </div>
              {data.meta.folded_models.length > 0 && (
                <p className="note">
                  Showing the top {aliases.length} models by call volume. Not charted: {data.meta.folded_models.join(", ")}.
                </p>
              )}
            </CollapsiblePanel>

            <CollapsiblePanel
              id="dashboard-heatmap"
              title="Pass rate by pack — latest week"
              sub="Read by column: the model for a regulated workload wins grounding and hallucination, not the average — click any header to sort by that pack"
            >
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleMatrixSort("model")}>
                        Model{matrixSortArrow("model")}
                      </th>
                      {data.packs.map((p, i) => (
                        <th className="num sortable" style={{ cursor: "pointer" }} key={p} onClick={() => toggleMatrixSort(i)}>
                          {p.split("_").slice(1).join(" ")}
                          {matrixSortArrow(i)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedMatrix.map((row) => (
                      <tr key={row.model}>
                        <td className="mono" style={{ fontWeight: 600 }}>
                          {row.model}
                        </td>
                        {row.cells.map((v, i) => (
                          <td className="num" key={i}>
                            {v === null ? (
                              <span style={{ color: "var(--muted)" }}>—</span>
                            ) : (
                              <span className="heat" style={heatStyle(v)}>
                                {(v * 100).toFixed(0)}%
                              </span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CollapsiblePanel>
          </>
        )}
      </div>
    </>
  );
}

function heatStyle(v: number): React.CSSProperties {
  if (v >= 0.95) return { background: "#cde2fb", color: "#0d366b" };
  if (v >= 0.88) return { background: "#9ec5f4", color: "#0d366b" };
  if (v >= 0.8) return { background: "#6da7ec", color: "#0d366b" };
  if (v >= 0.72) return { background: "#3987e5", color: "#ffffff" };
  return { background: "#184f95", color: "#ffffff" };
}
