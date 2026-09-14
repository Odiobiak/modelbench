import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import Drawer from "../components/Drawer";
import StatTile from "../components/StatTile";
import CollapsiblePanel from "../components/CollapsiblePanel";
import { useExplorerRows, useExplorerSummary, useModels, usePacks, useRuns } from "../api/hooks";
import { fmtDate, fmtMoney, fmtVal } from "../format";
import {
  GroupedBar,
  Histogram,
  OutcomeBar,
  RANKED_CHART_CAP,
  RankedBar,
  SERIES_SLOTS,
  fmtMetric,
  meanOf,
  quantileOf,
  seriesColor,
  stdevOf,
} from "../components/ExplorerCharts";
import type { ExplorerCaseRow, ExplorerSummaryRow } from "../api/types";

// ── per-model index, computed from raw call rows rather than the
// per-(run, model) summary ───────────────────────────────────────────────
// Two reasons it can't come from the summary: selecting three runs should
// fold all three runs' calls into one comparison, and the consistency
// numbers below have no meaning at summary granularity at all -- they're
// about disagreement *between repeats of the same case*, which the summary
// has already averaged away.
interface ModelIndex {
  model_alias: string;
  calls: number;
  // performance
  ttftP50: number | null;
  ttftP95: number | null;
  latP50: number | null;
  latP95: number | null;
  tpot: number | null;
  tps: number | null;
  cacheHit: number | null;
  // reliability
  pass: number;
  fail: number;
  error: number;
  errorRate: number | null;
  retries: number;
  rateLimited: number;
  truncated: number;
  // consistency
  repeatCases: number;
  flipRate: number | null;
  latencyCv: number | null;
}

function buildModelIndex(rows: ExplorerCaseRow[]): ModelIndex[] {
  const byModel = new Map<string, ExplorerCaseRow[]>();
  for (const r of rows) {
    const list = byModel.get(r.model_alias);
    if (list) list.push(r);
    else byModel.set(r.model_alias, [r]);
  }

  const out: ModelIndex[] = [];
  for (const [model_alias, list] of byModel) {
    const ok = list.filter((r) => r.ok);
    const nums = (pick: (r: ExplorerCaseRow) => number | null) =>
      ok.map(pick).filter((v): v is number => v != null);

    const ttfts = nums((r) => r.ttft_ms).sort((a, b) => a - b);
    const lats = nums((r) => r.total_latency_ms).sort((a, b) => a - b);
    const tpots = nums((r) => r.tpot_ms).sort((a, b) => a - b);
    const tpss = nums((r) => r.tokens_per_second).sort((a, b) => a - b);
    const latMean = meanOf(lats);
    const latSd = stdevOf(lats);

    // Verdict agreement across repeats of one case. A model that flips a
    // verdict between two identical calls is a different kind of risk from
    // one that's consistently wrong -- the second you can design around,
    // the first you can't.
    const byCase = new Map<string, string[]>();
    for (const r of list) {
      const key = `${r.run_id}::${r.pack}::${r.case_key}`;
      const verdict = r.ok ? String(r.passed) : "error";
      const seen = byCase.get(key);
      if (seen) seen.push(verdict);
      else byCase.set(key, [verdict]);
    }
    let repeatCases = 0;
    let flipped = 0;
    for (const verdicts of byCase.values()) {
      if (verdicts.length < 2) continue;
      repeatCases += 1;
      if (new Set(verdicts).size > 1) flipped += 1;
    }

    const errors = list.filter((r) => !r.ok).length;
    out.push({
      model_alias,
      calls: list.length,
      ttftP50: quantileOf(ttfts, 0.5),
      ttftP95: quantileOf(ttfts, 0.95),
      latP50: quantileOf(lats, 0.5),
      latP95: quantileOf(lats, 0.95),
      tpot: quantileOf(tpots, 0.5),
      tps: quantileOf(tpss, 0.5),
      cacheHit: meanOf(nums((r) => r.cache_hit_ratio)),
      pass: list.filter((r) => r.ok && r.passed === true).length,
      fail: list.filter((r) => r.ok && r.passed === false).length,
      error: errors,
      errorRate: list.length ? errors / list.length : null,
      retries: list.reduce((s, r) => s + (r.retry_count ?? 0), 0),
      rateLimited: list.filter((r) => r.rate_limited).length,
      truncated: list.filter((r) => r.finish_reason === "length").length,
      repeatCases,
      flipRate: repeatCases ? flipped / repeatCases : null,
      latencyCv: latMean && latSd !== null && latMean > 0 ? latSd / latMean : null,
    });
  }
  return out;
}

// Same 90%/70% bands bench.criteria.grade() uses, and the same classes
// RunDetail/Models already color pills with (see styles.css .pill.*).
function gradeClass(v: number | null | undefined): "on" | "warn" | "bad" | "off" {
  if (v === null || v === undefined || Number.isNaN(v)) return "off";
  if (v >= 0.9) return "on";
  if (v >= 0.7) return "warn";
  return "bad";
}
function pct(v: number | null | undefined): string {
  return v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(0)}%`;
}

function parseScores(json: string): [string, number][] {
  try {
    const obj = JSON.parse(json || "{}");
    if (obj && typeof obj === "object") return Object.entries(obj).filter((e): e is [string, number] => typeof e[1] === "number");
  } catch {
    /* malformed or empty */
  }
  return [];
}

// ── chart tooltips (same .tip/.th/.r contract as RunComparePage's) ────────
interface RechartsPayloadEntry {
  dataKey?: string | number;
  name?: string | number;
  value?: number | null;
  color?: string;
  fill?: string;
  payload?: Record<string, unknown>;
}

function CriteriaTooltip({ active, payload, label }: { active?: boolean; payload?: RechartsPayloadEntry[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tip" style={{ opacity: 1, position: "static" }}>
      <div className="th">{label}</div>
      {payload.map((p) => (
        <div className="r" key={String(p.dataKey)}>
          <span>
            <i style={{ background: p.color ?? p.fill }} />
            {p.name}
          </span>
          <span>{p.value == null ? "—" : `${Math.round(p.value * 100)}%`}</span>
        </div>
      ))}
    </div>
  );
}

function ScatterTooltip({ active, payload }: { active?: boolean; payload?: RechartsPayloadEntry[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload as
    | { model_alias: string; ttft_ms_p95: number | null; cost_per_success: number | null; pass_rate: number | null }
    | undefined;
  if (!d) return null;
  return (
    <div className="tip" style={{ opacity: 1, position: "static" }}>
      <div className="th">{d.model_alias}</div>
      <div className="r">
        <span>TTFT p95</span>
        <span>{fmtVal(d.ttft_ms_p95, "ms")}</span>
      </div>
      <div className="r">
        <span>Cost / success</span>
        <span>{fmtMoney(d.cost_per_success)}</span>
      </div>
      <div className="r">
        <span>Pass rate</span>
        <span>{pct(d.pass_rate)}</span>
      </div>
    </div>
  );
}

// ── scope chip-picker, same interaction as LaunchPage's pack picker ───────
function ChipPicker({
  label,
  options,
  selected,
  onChange,
  renderOption,
}: {
  label: string;
  options: { value: string; display: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  renderOption?: (value: string) => string;
}) {
  const available = options.filter((o) => !selected.includes(o.value));
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--muted)", marginBottom: 6 }}>
        {label}
        {selected.length > 0 && (
          <>
            {" · "}
            <a
              href="#"
              style={{ color: "var(--accent)", textTransform: "none", letterSpacing: 0 }}
              onClick={(e) => {
                e.preventDefault();
                onChange([]);
              }}
            >
              clear
            </a>
          </>
        )}
      </div>
      <div className="chiprow">
        {selected.map((v) => (
          <span className="chip active" key={v}>
            {renderOption ? renderOption(v) : v}
            <span role="button" aria-label={`Remove ${v}`} style={{ marginLeft: 2, opacity: 0.6 }} onClick={() => onChange(selected.filter((s) => s !== v))}>
              ×
            </span>
          </span>
        ))}
        {available.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) onChange([...selected, e.target.value]);
            }}
            style={{ width: "auto", fontSize: 12, padding: "5px 8px" }}
          >
            <option value="">+ Add {label.toLowerCase()}…</option>
            {available.map((o) => (
              <option key={o.value} value={o.value}>
                {o.display}
              </option>
            ))}
          </select>
        )}
        {options.length === 0 && <span className="empty-hint">None yet.</span>}
      </div>
    </div>
  );
}

type SummarySortKey =
  | "run_started_at"
  | "model_alias"
  | "pass_rate"
  | "ttft_ms_p95"
  | "latency_ms_p95"
  | "cost_per_success"
  | "overall_pass_rate"
  | "chain_reliability"
  | string;

function summarySortValue(r: ExplorerSummaryRow, key: SummarySortKey): number | string {
  if (key === "run_started_at") return r.run_started_at;
  if (key === "model_alias") return r.model_alias;
  const v = (r as unknown as Record<string, number | null>)[key];
  return v ?? -1;
}

type CaseSortKey = "ts_utc" | "run_id" | "model_alias" | "pack" | "case_key" | "passed" | "total_latency_ms" | "cost_total_usd";

function caseSortValue(r: ExplorerCaseRow, key: CaseSortKey): number | string {
  if (key === "passed") return r.passed === true ? 2 : r.passed === false ? 1 : 0;
  if (key === "total_latency_ms" || key === "cost_total_usd") return r[key] ?? -1;
  return r[key] as string;
}

export default function ExplorerPage() {
  const { data: runs } = useRuns();
  const { data: models } = useModels();
  const { data: packs } = usePacks();

  const [runIds, setRunIds] = useState<string[]>([]);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [packNames, setPackNames] = useState<string[]>([]);

  const scope = useMemo(() => ({ runIds, modelIds, packs: packNames }), [runIds, modelIds, packNames]);
  const { data: summary, isLoading: summaryLoading, error: summaryError } = useExplorerSummary(scope);
  const { data: rows, isLoading: rowsLoading } = useExplorerRows(scope, true);

  const [summarySort, setSummarySort] = useState<SummarySortKey>("run_started_at");
  const [summaryDir, setSummaryDir] = useState<"asc" | "desc">("desc");
  const [summaryFilterModel, setSummaryFilterModel] = useState("");
  const [summarySearch, setSummarySearch] = useState("");

  const [caseFilterPack, setCaseFilterPack] = useState("");
  const [caseFilterModel, setCaseFilterModel] = useState("");
  const [caseFilterDifficulty, setCaseFilterDifficulty] = useState("");
  const [caseFilterPass, setCaseFilterPass] = useState<"all" | "pass" | "fail" | "error">("all");
  const [caseSearch, setCaseSearch] = useState("");
  const [caseSort, setCaseSort] = useState<CaseSortKey>("ts_utc");
  const [caseDir, setCaseDir] = useState<"asc" | "desc">("desc");
  const [detailRow, setDetailRow] = useState<ExplorerCaseRow | null>(null);

  // Collapsed by default (see CollapsiblePanel below) -- this table is where
  // all the scrolling came from (every raw call in scope, easily hundreds of
  // rows). Paginated once open so opening it doesn't just move the problem
  // below the fold.
  const [casePage, setCasePage] = useState(0);
  const CASE_PAGE_SIZE = 25;

  const completedRuns = useMemo(() => (runs ?? []).filter((r) => r.status === "completed"), [runs]);

  // The charts answer "how does each model look right now", not "how has
  // every run of it looked" -- the table above already carries every
  // (run, model) row in full. Collapsed here to one row per model (its most
  // recent run in the current scope) so the visuals stay a comparison, not a
  // history.
  const latestPerModel = useMemo(() => {
    const map = new Map<string, ExplorerSummaryRow>();
    for (const r of summary?.rows ?? []) {
      const prev = map.get(r.model_alias);
      if (!prev || r.run_started_at > prev.run_started_at) map.set(r.model_alias, r);
    }
    return Array.from(map.values()).sort((a, b) => (b.overall_pass_rate ?? 0) - (a.overall_pass_rate ?? 0));
  }, [summary]);

  // Grouped-bar series cap: past 8, hues stop being distinguishable under
  // CVD (see the dataviz skill's series-count ladder) -- fold the rest into
  // a note instead of generating a 9th color. Same cap bench/dashboard.py
  // already uses for its trend charts.
  const chartModels = latestPerModel.slice(0, SERIES_SLOTS);
  const foldedChartModels = latestPerModel.slice(SERIES_SLOTS);

  const criteria = useMemo(() => summary?.criteria ?? [], [summary]);
  const criteriaChartData = useMemo(
    () =>
      criteria.map((c) => {
        const row: Record<string, string | number | null> = { criterion: c.label };
        for (const m of chartModels) row[m.model_alias] = (m as unknown as Record<string, number | null>)[c.key];
        return row;
      }),
    [criteria, chartModels]
  );

  // Identity here rides on the direct label beside each point, not on hue --
  // a scatter comparing every pair of points can't stay CVD-safe with a
  // per-model categorical color past ~3 series, so this deliberately uses a
  // single accent hue for every dot instead of one color per model.
  const scatterData = useMemo(
    () => latestPerModel.filter((m) => m.ttft_ms_p95 != null && m.cost_per_success != null),
    [latestPerModel]
  );

  // Labeling every point collides into unreadable text wherever models
  // cluster (typically at low latency) -- the anti-pattern this skill calls
  // out by name. Direct-label only the extremes the scatter's own caption
  // promises ("fast and cheap", "big bubble") and leave the rest to the
  // hover tooltip + the table below, same as the marks-and-anatomy rule for
  // any chart with more than a couple of series.
  const scatterCallouts = useMemo(() => {
    if (scatterData.length === 0) return new Set<string>();
    const fastest = scatterData.reduce((a, b) => ((b.ttft_ms_p95 ?? Infinity) < (a.ttft_ms_p95 ?? Infinity) ? b : a));
    const cheapest = scatterData.reduce((a, b) => ((b.cost_per_success ?? Infinity) < (a.cost_per_success ?? Infinity) ? b : a));
    const bestPass = scatterData.reduce((a, b) => ((b.pass_rate ?? 0) > (a.pass_rate ?? 0) ? b : a));
    return new Set([fastest.model_alias, cheapest.model_alias, bestPass.model_alias]);
  }, [scatterData]);

  const chainRanked = useMemo(
    () => [...latestPerModel].filter((m) => m.chain_reliability != null).sort((a, b) => (b.chain_reliability ?? 0) - (a.chain_reliability ?? 0)),
    [latestPerModel]
  );
  const chainData = chainRanked.slice(0, RANKED_CHART_CAP);
  const chainFolded = chainRanked.slice(RANKED_CHART_CAP);

  // Cost ranking comes from the summary (cost_per_success is computed there,
  // across the whole run); the latency/reliability/consistency rankings come
  // from the raw rows instead -- see `ranked` below.
  const costRanked = useMemo(
    () => latestPerModel.filter((m) => m.cost_per_success != null).sort((a, b) => (a.cost_per_success ?? 0) - (b.cost_per_success ?? 0)),
    [latestPerModel]
  );
  const costChartData = costRanked.slice(0, RANKED_CHART_CAP);
  const costFolded = costRanked.slice(RANKED_CHART_CAP);
  // report.summarize() reports $0 (not null) when no cost_total_usd was ever
  // computed for a model at all -- indistinguishable, by value alone, from a
  // genuinely free model. A bar chart where every bar is zero-width reads as
  // broken, not as "no data" -- so detect it and say so explicitly instead.
  const costHasSignal = costChartData.some((m) => (m.cost_per_success ?? 0) > 0);

  // The headline "what got captured on every call" numbers (README's own
  // list: latency, tokens, cost, reliability) -- computed from the raw rows,
  // not the per-model summary, so this reflects literally every call in
  // scope rather than one row per model.
  const rawStats = useMemo(() => {
    const list = rows ?? [];
    const total = list.length;
    const okList = list.filter((r) => r.ok);
    const ttfts = okList
      .map((r) => r.ttft_ms)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    const spend = list.reduce((sum, r) => sum + (r.cost_total_usd ?? 0), 0);
    const rateLimited = list.filter((r) => r.rate_limited).length;
    const tokenTotals = okList.map((r) => (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0)).filter((v) => v > 0);
    const lats = okList
      .map((r) => r.total_latency_ms)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    const tpots = okList.map((r) => r.tpot_ms).filter((v): v is number => v != null).sort((a, b) => a - b);
    const tpss = okList.map((r) => r.tokens_per_second).filter((v): v is number => v != null).sort((a, b) => a - b);
    const caches = okList.map((r) => r.cache_hit_ratio).filter((v): v is number => v != null);
    return {
      total,
      spend,
      ttftP50: quantileOf(ttfts, 0.5),
      ttftP95: quantileOf(ttfts, 0.95),
      latP50: quantileOf(lats, 0.5),
      latP95: quantileOf(lats, 0.95),
      tpot: quantileOf(tpots, 0.5),
      tps: quantileOf(tpss, 0.5),
      cacheHit: meanOf(caches),
      errorRate: total ? 1 - okList.length / total : null,
      rateLimited,
      retries: list.reduce((s, r) => s + (r.retry_count ?? 0), 0),
      truncated: list.filter((r) => r.finish_reason === "length").length,
      avgTokens: tokenTotals.length ? tokenTotals.reduce((a, b) => a + b, 0) / tokenTotals.length : null,
    };
  }, [rows]);

  // Per-model performance / reliability / consistency, plus the ranked
  // slices each chart below renders. All from the raw rows in scope.
  const modelIndex = useMemo(() => buildModelIndex(rows ?? []), [rows]);

  const ranked = useMemo(() => {
    const by = (
      pick: (m: ModelIndex) => number | null,
      dir: "asc" | "desc"
    ): { data: { model_alias: string; value: number | null }[]; folded: number } => {
      const list = modelIndex
        .filter((m) => pick(m) !== null)
        .map((m) => ({ model_alias: m.model_alias, value: pick(m) }))
        .sort((a, b) => (dir === "asc" ? (a.value ?? 0) - (b.value ?? 0) : (b.value ?? 0) - (a.value ?? 0)));
      return { data: list.slice(0, RANKED_CHART_CAP), folded: Math.max(0, list.length - RANKED_CHART_CAP) };
    };
    return {
      ttft: by((m) => m.ttftP95, "asc"),
      latency: by((m) => m.latP95, "asc"),
      tpot: by((m) => m.tpot, "asc"),
      tps: by((m) => m.tps, "desc"),
      cache: by((m) => m.cacheHit, "desc"),
      errorRate: by((m) => m.errorRate, "desc"),
      retries: by((m) => (m.retries > 0 ? m.retries : null), "desc"),
      flip: by((m) => m.flipRate, "desc"),
      cv: by((m) => m.latencyCv, "desc"),
    };
  }, [modelIndex]);

  // Outcome mix per model, worst-first so whatever needs attention is at
  // the top of the bar list rather than buried mid-scroll.
  const outcomeData = useMemo(
    () =>
      [...modelIndex]
        .sort((a, b) => b.error + b.fail - (a.error + a.fail))
        .slice(0, RANKED_CHART_CAP)
        .map((m) => ({ model_alias: m.model_alias, pass: m.pass, fail: m.fail, error: m.error })),
    [modelIndex]
  );

  // Model comparison's own visual: pass rate per model, grouped by run, so
  // selecting several runs shows the movement between them rather than
  // collapsing to one bar per model like the sections above do.
  const comparisonChart = useMemo(() => {
    const runsInScope: { id: string; label: string }[] = [];
    const seen = new Set<string>();
    for (const r of [...(summary?.rows ?? [])].sort((a, b) => a.run_started_at.localeCompare(b.run_started_at))) {
      if (seen.has(r.run_id)) continue;
      seen.add(r.run_id);
      runsInScope.push({ id: r.run_id, label: `${fmtDate(r.run_started_at)} · ${r.run_id.slice(-6)}` });
    }
    const aliases = Array.from(new Set((summary?.rows ?? []).map((r) => r.model_alias)));
    const series = aliases.slice(0, SERIES_SLOTS).map((key, i) => ({ key, color: seriesColor(i) }));
    const seriesKeys = new Set(series.map((s) => s.key));
    const rowsOut = runsInScope.map((run) => {
      const row: Record<string, string | number | null> = { run: run.label };
      for (const r of summary?.rows ?? []) {
        if (r.run_id === run.id && seriesKeys.has(r.model_alias)) row[r.model_alias] = r.pass_rate;
      }
      return row;
    });
    return { rows: rowsOut, series, folded: Math.max(0, aliases.length - SERIES_SLOTS) };
  }, [summary]);

  const scopeFlipRate = useMemo(() => {
    const withRepeats = modelIndex.filter((m) => m.repeatCases > 0);
    if (withRepeats.length === 0) return null;
    const cases = withRepeats.reduce((s, m) => s + m.repeatCases, 0);
    const flipped = withRepeats.reduce((s, m) => s + m.repeatCases * (m.flipRate ?? 0), 0);
    return cases ? flipped / cases : null;
  }, [modelIndex]);

  const summaryModelOptions = useMemo(
    () => Array.from(new Set((summary?.rows ?? []).map((r) => r.model_alias))).sort(),
    [summary]
  );

  const sortedSummary = useMemo(() => {
    let list = summary?.rows ?? [];
    if (summaryFilterModel) list = list.filter((r) => r.model_alias === summaryFilterModel);
    if (summarySearch.trim()) {
      const needle = summarySearch.trim().toLowerCase();
      list = list.filter((r) => r.model_alias.toLowerCase().includes(needle) || r.run_id.toLowerCase().includes(needle));
    }
    const sorted = [...list].sort((a, b) => {
      const av = summarySortValue(a, summarySort);
      const bv = summarySortValue(b, summarySort);
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    if (summaryDir === "desc") sorted.reverse();
    return sorted;
  }, [summary, summaryFilterModel, summarySearch, summarySort, summaryDir]);

  function toggleSummarySort(key: SummarySortKey) {
    if (summarySort === key) setSummaryDir(summaryDir === "asc" ? "desc" : "asc");
    else {
      setSummarySort(key);
      setSummaryDir("desc");
    }
  }
  function summaryArrow(key: SummarySortKey) {
    return summarySort === key ? (summaryDir === "asc" ? " ▲" : " ▼") : "";
  }

  const filteredCases = useMemo(() => {
    let list = rows ?? [];
    if (caseFilterPack) list = list.filter((r) => r.pack === caseFilterPack);
    if (caseFilterModel) list = list.filter((r) => r.model_alias === caseFilterModel);
    if (caseFilterDifficulty) list = list.filter((r) => r.difficulty === caseFilterDifficulty);
    if (caseFilterPass === "pass") list = list.filter((r) => r.passed === true);
    if (caseFilterPass === "fail") list = list.filter((r) => r.passed === false && r.ok);
    if (caseFilterPass === "error") list = list.filter((r) => !r.ok);
    if (caseSearch.trim()) {
      const needle = caseSearch.trim().toLowerCase();
      list = list.filter((r) => r.case_key.toLowerCase().includes(needle) || r.response_text.toLowerCase().includes(needle));
    }
    const sorted = [...list].sort((a, b) => {
      const av = caseSortValue(a, caseSort);
      const bv = caseSortValue(b, caseSort);
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    if (caseDir === "desc") sorted.reverse();
    return sorted;
  }, [rows, caseFilterPack, caseFilterModel, caseFilterDifficulty, caseFilterPass, caseSearch, caseSort, caseDir]);

  // Any change to what's being filtered/sorted invalidates the current page
  // -- each filter/sort/scope-changing handler below also calls
  // setCasePage(0) directly, rather than watching for the change in an
  // effect, so the reset happens as part of the event that caused it.
  const caseTotalPages = Math.max(1, Math.ceil(filteredCases.length / CASE_PAGE_SIZE));
  const caseClampedPage = Math.min(casePage, caseTotalPages - 1);
  const pagedCases = filteredCases.slice(caseClampedPage * CASE_PAGE_SIZE, (caseClampedPage + 1) * CASE_PAGE_SIZE);

  // Case explorer's own visual: the outcome mix and latency shape of exactly
  // what the filters currently select, not of the whole scope -- so
  // narrowing to one pack or one model re-draws it.
  const filteredOutcome = useMemo(() => {
    const byModel = new Map<string, { pass: number; fail: number; error: number }>();
    for (const r of filteredCases) {
      const entry = byModel.get(r.model_alias) ?? { pass: 0, fail: 0, error: 0 };
      if (!r.ok) entry.error += 1;
      else if (r.passed === true) entry.pass += 1;
      else entry.fail += 1;
      byModel.set(r.model_alias, entry);
    }
    return Array.from(byModel, ([model_alias, v]) => ({ model_alias, ...v }))
      .sort((a, b) => b.error + b.fail - (a.error + a.fail))
      .slice(0, RANKED_CHART_CAP);
  }, [filteredCases]);

  function toggleCaseSort(key: CaseSortKey) {
    if (caseSort === key) setCaseDir(caseDir === "asc" ? "desc" : "asc");
    else {
      setCaseSort(key);
      setCaseDir("desc");
    }
  }
  function caseArrow(key: CaseSortKey) {
    return caseSort === key ? (caseDir === "asc" ? " ▲" : " ▼") : "";
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Explorer</h1>
          <p>
            Pivot across any runs, models, and test cases. Raw metrics and agentic-capability grades side by side, filterable and
            sortable.
          </p>
        </div>
      </div>
      <div className="content">
        <CollapsiblePanel id="explorer-scope" title="Scope" sub="Empty = every run, model, or pack in history" style={{ marginBottom: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, padding: "0 18px 16px" }}>
            <ChipPicker
              label="Runs"
              options={completedRuns.map((r) => ({ value: r.run_id, display: `${fmtDate(r.created_at)} · ${r.run_id.slice(-6)}` }))}
              selected={runIds}
              onChange={setRunIds}
              renderOption={(v) => {
                const r = completedRuns.find((x) => x.run_id === v);
                return r ? `${fmtDate(r.created_at)} · ${v.slice(-6)}` : v;
              }}
            />
            <ChipPicker
              label="Models"
              options={(models ?? []).map((m) => ({ value: m.alias, display: m.alias }))}
              selected={modelIds}
              onChange={setModelIds}
            />
            <ChipPicker
              label="Packs"
              options={(packs ?? []).map((p) => ({ value: p.name, display: p.name }))}
              selected={packNames}
              onChange={setPackNames}
            />
          </div>
        </CollapsiblePanel>

        {!rowsLoading && rows && rows.length > 0 && (
          <>
            <CollapsiblePanel
              id="explorer-performance"
              title="Performance"
              sub="Speed, throughput and cache behaviour across every call in scope. TTFT is what a person feels; total latency is what a batch job pays for."
              style={{ marginBottom: 16 }}
            >
              <div className="tiles" style={{ padding: "0 18px 16px" }}>
                <StatTile label="Calls in scope" value={rawStats.total.toLocaleString()} sub="every repeat, every model" />
                <StatTile
                  label="TTFT p95"
                  value={fmtMetric(rawStats.ttftP95, "ms")}
                  sub={`p50 ${fmtMetric(rawStats.ttftP50, "ms")}`}
                  hint="Time to first token at the 95th percentile -- the slow-but-not-freak call a person actually notices."
                />
                <StatTile
                  label="Latency p95"
                  value={fmtMetric(rawStats.latP95, "ms")}
                  sub={`p50 ${fmtMetric(rawStats.latP50, "ms")}`}
                  hint="Total wall-clock for the whole response, first token to last."
                />
                <StatTile
                  label="TPOT"
                  value={fmtMetric(rawStats.tpot, "ms")}
                  sub="median time per output token"
                  hint="Time per output token after the first -- how fast it streams once it has started."
                />
                <StatTile
                  label="Throughput"
                  value={rawStats.tps != null ? `${fmtMetric(rawStats.tps, "num")} tok/s` : "—"}
                  sub="median tokens / second"
                />
                <StatTile
                  label="Cache hit ratio"
                  value={fmtMetric(rawStats.cacheHit, "pct")}
                  sub="share of prompt served from cache"
                  hint="A high hit ratio means cheap today -- and a cost cliff the moment your prompt changes."
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 20, padding: "4px 18px 20px" }}>
                <RankedBar
                  title="TTFT p95 by model -- fastest first"
                  data={ranked.ttft.data}
                  foldedCount={ranked.ttft.folded}
                  fmt="ms"
                  valueLabel="TTFT p95"
                />
                <RankedBar
                  title="Total latency p95 by model -- fastest first"
                  data={ranked.latency.data}
                  foldedCount={ranked.latency.folded}
                  fmt="ms"
                  valueLabel="Latency p95"
                />
                <RankedBar
                  title="Throughput by model -- fastest first"
                  data={ranked.tps.data}
                  foldedCount={ranked.tps.folded}
                  fmt="num"
                  valueLabel="tokens / sec"
                  color="var(--s3)"
                />
                <RankedBar
                  title="Time per output token -- lowest first"
                  data={ranked.tpot.data}
                  foldedCount={ranked.tpot.folded}
                  fmt="ms"
                  valueLabel="TPOT"
                  color="var(--s3)"
                />
                <RankedBar
                  title="Cache hit ratio by model -- highest first"
                  data={ranked.cache.data}
                  foldedCount={ranked.cache.folded}
                  fmt="pct"
                  valueLabel="cache hit"
                  domain={[0, 1]}
                  color="var(--s7)"
                  emptyHint="No provider in this scope reported cache usage."
                />
                <Histogram
                  title="Where latency actually lands -- every call in scope"
                  values={(rows ?? []).map((r) => r.total_latency_ms).filter((v): v is number => v != null)}
                  fmt="ms"
                />
              </div>
            </CollapsiblePanel>

            <CollapsiblePanel
              id="explorer-reliability"
              title="Reliability"
              sub="Whether a call comes back at all, and what it costs you in retries. A model 2% slower that never throttles is usually the better production bet."
              defaultCollapsed
              style={{ marginBottom: 16 }}
            >
              <div className="tiles" style={{ padding: "0 18px 16px" }}>
                <StatTile
                  label="Error rate"
                  value={pct(rawStats.errorRate)}
                  sub="calls with no usable response"
                  alarm={(rawStats.errorRate ?? 0) > 0.1}
                  hint="ok=false rows -- timeouts, 4xx/5xx, or an empty response."
                />
                <StatTile
                  label="Rate-limited"
                  value={rawStats.rateLimited.toLocaleString()}
                  sub="429s -- throttled reads as slow, not broken"
                  alarm={rawStats.rateLimited > 0}
                />
                <StatTile
                  label="Retries"
                  value={rawStats.retries.toLocaleString()}
                  sub="attempts beyond the first"
                  alarm={rawStats.retries > 0}
                  hint="Every retry is latency someone waits through and tokens you pay for twice."
                />
                <StatTile
                  label="Truncated"
                  value={rawStats.truncated.toLocaleString()}
                  sub="hit the max-token ceiling"
                  alarm={rawStats.truncated > 0}
                  hint="finish_reason = length -- cut off mid-sentence, which usually fails a check for the wrong reason."
                />
                <StatTile
                  label="Avg tokens / call"
                  value={rawStats.avgTokens != null ? Math.round(rawStats.avgTokens).toLocaleString() : "—"}
                  sub="prompt + completion"
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 20, padding: "4px 18px 20px" }}>
                <OutcomeBar title="Outcome mix by model -- most failures first" data={outcomeData} />
                <RankedBar
                  title="Error rate by model -- worst first"
                  data={ranked.errorRate.data}
                  foldedCount={ranked.errorRate.folded}
                  fmt="pct"
                  valueLabel="error rate"
                  domain={[0, 1]}
                  color="var(--critical)"
                />
                <RankedBar
                  title="Retries by model -- most first"
                  data={ranked.retries.data}
                  foldedCount={ranked.retries.folded}
                  fmt="num"
                  valueLabel="retries"
                  color="var(--s4)"
                  emptyHint="No retries were needed anywhere in this scope."
                />
              </div>
            </CollapsiblePanel>

            <CollapsiblePanel
              id="explorer-consistency"
              title="Consistency & variance"
              sub="Same prompt, same model, run again -- does it agree with itself? Measured across repeats of one case, so it needs a run with repeats above 1."
              defaultCollapsed
              style={{ marginBottom: 16 }}
            >
              <div className="tiles" style={{ padding: "0 18px 16px" }}>
                <StatTile
                  label="Verdict flip rate"
                  value={pct(scopeFlipRate)}
                  sub="repeated cases that disagreed"
                  alarm={(scopeFlipRate ?? 0) > 0.1}
                  hint="Share of repeated cases where the pass/fail verdict was not the same every time. Consistently wrong you can design around; flipping you cannot."
                />
                <StatTile
                  label="Repeated cases"
                  value={modelIndex.reduce((s, m) => s + m.repeatCases, 0).toLocaleString()}
                  sub="cases run more than once in scope"
                />
                <StatTile
                  label="Models measured"
                  value={modelIndex.filter((m) => m.repeatCases > 0).length.toLocaleString()}
                  sub="with at least one repeated case"
                />
              </div>
              {modelIndex.every((m) => m.repeatCases === 0) ? (
                <p className="note">
                  Nothing to measure yet — every case in this scope ran exactly once. Launch a run with <strong>repeats</strong> above 1
                  (Launch run → Run settings) and the flip rate and latency spread start reporting here.
                </p>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 20, padding: "4px 18px 20px" }}>
                  <RankedBar
                    title="Verdict flip rate by model -- least consistent first"
                    data={ranked.flip.data}
                    foldedCount={ranked.flip.folded}
                    fmt="pct"
                    valueLabel="flip rate"
                    domain={[0, 1]}
                    color="var(--s8)"
                    emptyHint="No case in scope was run more than once."
                    note="0% means every repeat of every case agreed with itself."
                  />
                  <RankedBar
                    title="Latency spread by model -- least predictable first"
                    data={ranked.cv.data}
                    foldedCount={ranked.cv.folded}
                    fmt="ratio"
                    valueLabel="coefficient of variation"
                    color="var(--s5)"
                    note="Standard deviation over mean. Past ~0.5 the model's speed is effectively unpredictable call to call."
                  />
                </div>
              )}
            </CollapsiblePanel>
          </>
        )}

        {summaryLoading && <p className="empty-hint">Loading…</p>}
        {!summaryLoading && !summaryError && latestPerModel.length > 0 && (
          <>
            <CollapsiblePanel
              id="explorer-cost"
              title="Cost"
              sub="What this scope actually spent, and what each model costs per case it gets right -- the number that decides a deployment, not list price per token."
              defaultCollapsed
              style={{ marginBottom: 16 }}
            >
              <div className="tiles" style={{ padding: "0 18px 16px" }}>
                <StatTile
                  label="Total spend"
                  value={rowsLoading ? "—" : fmtMoney(rawStats.spend)}
                  sub="summed across every call in scope"
                />
                <StatTile
                  label="Avg tokens / call"
                  value={rawStats.avgTokens != null ? Math.round(rawStats.avgTokens).toLocaleString() : "—"}
                  sub="prompt + completion"
                />
                <StatTile
                  label="Cache hit ratio"
                  value={fmtMetric(rawStats.cacheHit, "pct")}
                  sub="cheap now, cliff later if the prompt changes"
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 20, padding: "4px 18px 20px" }}>
                <RankedBar
                  title="Cost per success by model -- cheapest first"
                  data={costChartData.map((m) => ({ model_alias: m.model_alias, value: m.cost_per_success }))}
                  foldedCount={costFolded.length}
                  fmt="usd"
                  valueLabel="$ / success"
                  color="var(--s3)"
                  emptyHint="No cost data in this scope -- every call here has $0/unknown cost (a mock run, free-tier pricing, or models the catalogue never priced). Nothing to compare until a priced run is included."
                  note={
                    costHasSignal
                      ? "Total spend divided by cases passed -- a cheap model that fails often costs more per success than an expensive one that doesn't."
                      : undefined
                  }
                />
                <Histogram
                  title="Tokens per call -- every call in scope"
                  values={(rows ?? []).map((r) => r.total_tokens).filter((v): v is number => v != null)}
                  fmt="num"
                  color="var(--s3)"
                />
              </div>
            </CollapsiblePanel>

            <CollapsiblePanel
              id="explorer-visual-overview"
              title="Capability & quality"
              sub="What each model is actually good at, by criterion. Each model's most recent run in this scope -- the comparison table below keeps every run."
              defaultCollapsed
              style={{ marginBottom: 16 }}
            >

            <div style={{ padding: "4px 18px 20px" }}>
              <span className="kicker">Capability profile by criterion</span>
              <div className="chiprow" style={{ padding: "6px 0 4px" }}>
                {chartModels.map((m, i) => (
                  <span className="chip active" key={m.model_alias}>
                    <span className="sw" style={{ background: seriesColor(i) }} />
                    {m.model_alias}
                  </span>
                ))}
              </div>
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={criteriaChartData} margin={{ top: 10, right: 8, left: 0, bottom: 56 }}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis
                    dataKey="criterion"
                    tick={{ fontSize: 10.5, fill: "var(--muted)" }}
                    axisLine={{ stroke: "var(--line-strong)" }}
                    tickLine={false}
                    interval={0}
                    angle={-30}
                    textAnchor="end"
                    height={80}
                  />
                  <YAxis
                    domain={[0, 1]}
                    tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
                    tick={{ fontSize: 10.5, fill: "var(--muted)" }}
                    axisLine={false}
                    tickLine={false}
                    width={42}
                  />
                  <Tooltip content={<CriteriaTooltip />} />
                  {chartModels.map((m, i) => (
                    <Bar key={m.model_alias} dataKey={m.model_alias} name={m.model_alias} fill={seriesColor(i)} radius={[3, 3, 0, 0]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              {foldedChartModels.length > 0 && (
                <p className="note">
                  Not charted (past the {SERIES_SLOTS}-series legibility cap): {foldedChartModels.map((m) => m.model_alias).join(", ")}.
                  Narrow the scope above to compare them instead.
                </p>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(440px, 1fr))", gap: 20, padding: "4px 18px 20px" }}>
            <div>
              <span className="kicker">Speed vs. cost, sized by pass rate</span>
              <ResponsiveContainer width="100%" height={300}>
                <ScatterChart margin={{ top: 20, right: 24, left: 0, bottom: 24 }}>
                  <CartesianGrid stroke="var(--line)" />
                  <XAxis
                    type="number"
                    dataKey="ttft_ms_p95"
                    name="TTFT p95"
                    tickFormatter={(v: number) => fmtVal(v, "ms")}
                    tick={{ fontSize: 10.5, fill: "var(--muted)" }}
                    axisLine={{ stroke: "var(--line-strong)" }}
                    tickLine={false}
                    label={{ value: "TTFT p95 (lower is faster)", position: "insideBottom", offset: -12, fontSize: 11, fill: "var(--muted)" }}
                  />
                  <YAxis
                    type="number"
                    dataKey="cost_per_success"
                    name="Cost per success"
                    tickFormatter={(v: number) => fmtMoney(v)}
                    tick={{ fontSize: 10.5, fill: "var(--muted)" }}
                    axisLine={false}
                    tickLine={false}
                    width={70}
                    label={{ value: "$ / success (lower is cheaper)", angle: -90, position: "insideLeft", fontSize: 11, fill: "var(--muted)" }}
                  />
                  <ZAxis type="number" dataKey="pass_rate" range={[80, 500]} name="Pass rate" />
                  <Tooltip content={<ScatterTooltip />} cursor={{ stroke: "var(--line-strong)" }} />
                  <Scatter data={scatterData} fill="var(--accent)" fillOpacity={0.75}>
                    <LabelList
                      dataKey="model_alias"
                      // Recharts' own LabelList content-prop type is deep and private (a union
                      // including its internal RenderableText); narrowing here at the call site
                      // rather than reproducing that type.
                      content={((props: Record<string, unknown>) => {
                        const { x, y, value } = props;
                        if (typeof value !== "string" || !scatterCallouts.has(value)) return null;
                        if (typeof x !== "number" && typeof x !== "string") return null;
                        if (typeof y !== "number" && typeof y !== "string") return null;
                        return (
                          <text x={Number(x)} y={Number(y) - 10} textAnchor="middle" fontSize={10} fill="var(--ink-2)">
                            {value}
                          </text>
                        );
                      }) as unknown as never}
                    />
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
              <p className="note">
                Bottom-left is the sweet spot: fast and cheap. Bubble size is pass rate, so a big bubble down and to the left is the
                model to prefer; a big bubble elsewhere is winning on quality but paying for it in speed or cost. Only the fastest,
                cheapest, and highest-pass-rate points are labeled directly -- hover any bubble for its name and exact numbers.
              </p>
            </div>

            <RankedBar
              title="10-step agent-chain reliability -- most reliable first"
              data={chainData.map((m) => ({ model_alias: m.model_alias, value: m.chain_reliability }))}
              foldedCount={chainFolded.length}
              fmt="pct"
              valueLabel="chain reliability"
              domain={[0, 1]}
              note="Per-call pass rate raised to the 10th power -- what actually happens end to end once a model is chained into a multi-step agent. A model passing 95% of individual calls is still only ~60% reliable across 10 steps."
            />
            </div>
          </CollapsiblePanel>
          </>
        )}

        <CollapsiblePanel id="explorer-model-comparison" title="Model comparison" sub="One row per run × model. Click a column to sort." style={{ marginBottom: 16 }}>
          {summaryError && <p className="empty-hint">No results match this scope yet.</p>}
          {summaryLoading && <p className="empty-hint">Loading…</p>}
          {!summaryLoading && !summaryError && (
            <>
          <div style={{ padding: "4px 18px 16px" }}>
            <GroupedBar
              title="Pass rate by model, per run"
              rows={comparisonChart.rows}
              categoryKey="run"
              series={comparisonChart.series}
              fmt="pct"
              domain={[0, 1]}
              note={
                comparisonChart.folded > 0
                  ? `Not charted (past the ${SERIES_SLOTS}-series legibility cap): ${comparisonChart.folded} more model(s). Narrow the scope above, or read them in the table below.`
                  : "Each group is one run; each bar is one model in it. A bar dropping between runs is the regression to chase."
              }
            />
          </div>
          <div style={{ display: "flex", gap: 10, padding: "0 18px 14px", flexWrap: "wrap" }}>
            <select value={summaryFilterModel} onChange={(e) => setSummaryFilterModel(e.target.value)} style={{ width: "auto" }}>
              <option value="">All models</option>
              {summaryModelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Search model or run id…"
              value={summarySearch}
              onChange={(e) => setSummarySearch(e.target.value)}
              style={{ width: 220 }}
            />
            <span style={{ marginLeft: "auto", alignSelf: "center", fontSize: 12, color: "var(--muted)" }}>
              {sortedSummary.length} of {summary?.rows.length ?? 0} rows
            </span>
          </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleSummarySort("run_started_at")}>
                      Run{summaryArrow("run_started_at")}
                    </th>
                    <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleSummarySort("model_alias")}>
                      Model{summaryArrow("model_alias")}
                    </th>
                    <th className="num sortable" style={{ cursor: "pointer" }} onClick={() => toggleSummarySort("pass_rate")}>
                      Pass{summaryArrow("pass_rate")}
                    </th>
                    <th className="num sortable" style={{ cursor: "pointer" }} onClick={() => toggleSummarySort("ttft_ms_p95")}>
                      TTFT p95{summaryArrow("ttft_ms_p95")}
                    </th>
                    <th className="num sortable" style={{ cursor: "pointer" }} onClick={() => toggleSummarySort("latency_ms_p95")}>
                      Lat p95{summaryArrow("latency_ms_p95")}
                    </th>
                    <th className="num sortable" style={{ cursor: "pointer" }} onClick={() => toggleSummarySort("tokens_per_second")}>
                      Tok/s{summaryArrow("tokens_per_second")}
                    </th>
                    <th className="num sortable" style={{ cursor: "pointer" }} onClick={() => toggleSummarySort("cost_per_success")}>
                      $/success{summaryArrow("cost_per_success")}
                    </th>
                    <th className="num sortable" style={{ cursor: "pointer" }} onClick={() => toggleSummarySort("error_rate")}>
                      Errors{summaryArrow("error_rate")}
                    </th>
                    {criteria.map((c) => (
                      <th
                        key={c.key}
                        className="num sortable"
                        title={`${c.description} (packs: ${c.packs.join(", ")})`}
                        style={{ cursor: "pointer" }}
                        onClick={() => toggleSummarySort(c.key)}
                      >
                        {c.label}
                        {summaryArrow(c.key)}
                      </th>
                    ))}
                    <th
                      className="num sortable"
                      title="Raw pass rate raised to the 10th power -- what a 10-step agent chain's end-to-end reliability actually looks like."
                      style={{ cursor: "pointer" }}
                      onClick={() => toggleSummarySort("chain_reliability")}
                    >
                      Chain(10) rel.{summaryArrow("chain_reliability")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSummary.length === 0 && (
                    <tr>
                      <td colSpan={9 + criteria.length} className="empty-hint">
                        No rows in this scope.
                      </td>
                    </tr>
                  )}
                  {sortedSummary.map((r) => (
                    <tr key={`${r.run_id}::${r.model_alias}`}>
                      <td>
                        <div style={{ fontSize: 13 }}>{fmtDate(r.run_started_at)}</div>
                        <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
                          {r.run_id.slice(-6)}
                        </div>
                      </td>
                      <td style={{ fontWeight: 600 }}>{r.model_alias}</td>
                      <td className="num">{pct(r.pass_rate)}</td>
                      <td className="num">{fmtVal(r.ttft_ms_p95, "ms")}</td>
                      <td className="num">{fmtVal(r.latency_ms_p95, "ms")}</td>
                      <td className="num">{r.tokens_per_second ?? "—"}</td>
                      <td className="num">{fmtMoney(r.cost_per_success)}</td>
                      <td className="num">{pct(r.error_rate)}</td>
                      {criteria.map((c) => {
                        const v = (r as unknown as Record<string, number | null>)[c.key];
                        return (
                          <td className="num" key={c.key}>
                            <span className={`pill ${gradeClass(v)}`}>{pct(v)}</span>
                          </td>
                        );
                      })}
                      <td className="num mono" title="pass_rate^10, informational -- not graded good/bad">
                        {pct(r.chain_reliability)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </CollapsiblePanel>

        <CollapsiblePanel
          id="explorer-case-explorer"
          title="Case explorer"
          sub={`Every raw call in scope, paginated -- ${(rows ?? []).length.toLocaleString()} raw calls currently in scope. Collapsed by default -- the sections above are the at-a-glance view.`}
          defaultCollapsed
        >
          <div style={{ display: "flex", gap: 10, padding: "0 18px 14px", flexWrap: "wrap" }}>
            <select
              value={caseFilterPack}
              onChange={(e) => {
                setCaseFilterPack(e.target.value);
                setCasePage(0);
              }}
              style={{ width: "auto" }}
            >
              <option value="">All packs</option>
              {Array.from(new Set((rows ?? []).map((r) => r.pack))).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              value={caseFilterModel}
              onChange={(e) => {
                setCaseFilterModel(e.target.value);
                setCasePage(0);
              }}
              style={{ width: "auto" }}
            >
              <option value="">All models</option>
              {Array.from(new Set((rows ?? []).map((r) => r.model_alias))).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select
              value={caseFilterDifficulty}
              onChange={(e) => {
                setCaseFilterDifficulty(e.target.value);
                setCasePage(0);
              }}
              style={{ width: "auto" }}
            >
              <option value="">All difficulties</option>
              {Array.from(new Set((rows ?? []).map((r) => r.difficulty).filter(Boolean))).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <select
              value={caseFilterPass}
              onChange={(e) => {
                setCaseFilterPass(e.target.value as typeof caseFilterPass);
                setCasePage(0);
              }}
              style={{ width: "auto" }}
            >
              <option value="all">Pass + fail + error</option>
              <option value="pass">Passed only</option>
              <option value="fail">Failed only</option>
              <option value="error">Errored only</option>
            </select>
            <input
              type="text"
              placeholder="Search case id or response…"
              value={caseSearch}
              onChange={(e) => {
                setCaseSearch(e.target.value);
                setCasePage(0);
              }}
              style={{ width: 240 }}
            />
            <span style={{ marginLeft: "auto", alignSelf: "center", fontSize: 12, color: "var(--muted)" }}>
              {filteredCases.length} of {rows?.length ?? 0} calls
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 20, padding: "0 18px 18px" }}>
            <OutcomeBar title="Outcome mix of the current filter -- most failures first" data={filteredOutcome} />
            <Histogram
              title="Latency of the current filter"
              values={filteredCases.map((r) => r.total_latency_ms).filter((v): v is number => v != null)}
              fmt="ms"
            />
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleCaseSort("ts_utc")}>
                    Time{caseArrow("ts_utc")}
                  </th>
                  <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleCaseSort("model_alias")}>
                    Model{caseArrow("model_alias")}
                  </th>
                  <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleCaseSort("pack")}>
                    Pack{caseArrow("pack")}
                  </th>
                  <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleCaseSort("case_key")}>
                    Case{caseArrow("case_key")}
                  </th>
                  <th>Difficulty</th>
                  <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleCaseSort("passed")}>
                    Result{caseArrow("passed")}
                  </th>
                  <th className="num sortable" style={{ cursor: "pointer" }} onClick={() => toggleCaseSort("total_latency_ms")}>
                    Latency{caseArrow("total_latency_ms")}
                  </th>
                  <th className="num">Tokens in/out</th>
                  <th className="num sortable" style={{ cursor: "pointer" }} onClick={() => toggleCaseSort("cost_total_usd")}>
                    Cost{caseArrow("cost_total_usd")}
                  </th>
                  <th className="num">Retries</th>
                </tr>
              </thead>
              <tbody>
                {rowsLoading && (
                  <tr>
                    <td colSpan={10} className="empty-hint">
                      Loading…
                    </td>
                  </tr>
                )}
                {!rowsLoading && filteredCases.length === 0 && (
                  <tr>
                    <td colSpan={10} className="empty-hint">
                      No calls match this filter.
                    </td>
                  </tr>
                )}
                {pagedCases.map((r) => (
                  <tr key={r.record_id} style={{ cursor: "pointer" }} onClick={() => setDetailRow(r)}>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {fmtDate(r.ts_utc)}
                    </td>
                    <td>{r.model_alias}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {r.pack}
                    </td>
                    <td style={{ fontSize: 12.5 }}>{r.case_key}</td>
                    <td style={{ fontSize: 12, textTransform: "capitalize", color: "var(--ink-2)" }}>{r.difficulty || "—"}</td>
                    <td>
                      {!r.ok ? (
                        <span className="pill bad">error</span>
                      ) : r.passed === true ? (
                        <span className="pill on">pass</span>
                      ) : r.passed === false ? (
                        <span className="pill bad">fail</span>
                      ) : (
                        <span className="pill off">n/a</span>
                      )}
                      {r.rate_limited && (
                        <span className="pill warn" style={{ marginLeft: 4 }}>
                          429
                        </span>
                      )}
                    </td>
                    <td className="num">{fmtVal(r.total_latency_ms, "ms")}</td>
                    <td className="num">
                      {r.prompt_tokens ?? "—"} / {r.completion_tokens ?? "—"}
                    </td>
                    <td className="num">{fmtMoney(r.cost_total_usd)}</td>
                    <td className="num">{r.retry_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", flexWrap: "wrap" }}>
            <button className="btn sm ghost" disabled={caseClampedPage <= 0} onClick={() => setCasePage((p) => Math.max(0, p - 1))}>
              ← Prev
            </button>
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
              Page {caseClampedPage + 1} of {caseTotalPages} · {filteredCases.length} calls
            </span>
            <button
              className="btn sm ghost"
              disabled={caseClampedPage >= caseTotalPages - 1}
              onClick={() => setCasePage((p) => Math.min(caseTotalPages - 1, p + 1))}
            >
              Next →
            </button>
          </div>
        </CollapsiblePanel>
      </div>

      <Drawer
        open={!!detailRow}
        title={detailRow ? `${detailRow.model_alias} · ${detailRow.case_key}` : ""}
        onClose={() => setDetailRow(null)}
        footer={
          <button className="btn sm ghost" onClick={() => setDetailRow(null)}>
            Close
          </button>
        }
      >
        {detailRow && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--muted)", marginBottom: 4 }}>Response</div>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 12.5, background: "var(--surface-2)", padding: 10, borderRadius: 8 }}>
                {detailRow.response_text || "(empty)"}
              </pre>
            </div>
            {detailRow.error_message && (
              <div>
                <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--critical)", marginBottom: 4 }}>
                  {detailRow.error_type}
                </div>
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 12.5 }}>{detailRow.error_message}</pre>
              </div>
            )}
            <div>
              <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--muted)", marginBottom: 4 }}>Per-metric scores</div>
              {parseScores(detailRow.scores_json).length === 0 ? (
                <span className="empty-hint">No scored metrics on this row.</span>
              ) : (
                <table>
                  <tbody>
                    {parseScores(detailRow.scores_json).map(([k, v]) => (
                      <tr key={k}>
                        <td style={{ fontSize: 12.5 }}>{k}</td>
                        <td className="num mono" style={{ fontSize: 12.5 }}>
                          {v}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 10, fontSize: 12.5 }}>
              <div>
                <b>Served by</b>
                <div className="mono">{detailRow.model_served || "—"}</div>
              </div>
              <div>
                <b>Vendor</b>
                <div>{detailRow.vendor || "—"}</div>
              </div>
              <div>
                <b>TTFT / TPOT</b>
                <div>
                  {fmtVal(detailRow.ttft_ms, "ms")} / {detailRow.tpot_ms ? `${detailRow.tpot_ms.toFixed(0)} ms` : "—"}
                </div>
              </div>
              <div>
                <b>Tokens/sec</b>
                <div>{detailRow.tokens_per_second ? detailRow.tokens_per_second.toFixed(1) : "—"}</div>
              </div>
              <div>
                <b>Cache hit ratio</b>
                <div>{pct(detailRow.cache_hit_ratio)}</div>
              </div>
              <div>
                <b>Cost source</b>
                <div>{detailRow.cost_source || "—"}</div>
              </div>
              <div>
                <b>Judge model</b>
                <div className="mono">{detailRow.judge_model || "—"}</div>
              </div>
              <div>
                <b>Failed assertions</b>
                <div>{detailRow.failed_assertions || "—"}</div>
              </div>
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}
