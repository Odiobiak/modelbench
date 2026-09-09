import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { diffWords } from "diff";
import Drawer from "../components/Drawer";
import RunSummaryCharts from "../components/RunSummaryCharts";
import {
  useClearCaseOverride,
  useRun,
  useRunCases,
  useRunResults,
  useSetCaseOverride,
  useUpdateRunAnnotation,
} from "../api/hooks";
import { fmtDate, fmtMoney } from "../format";
import { toast } from "../toast";
import { ApiError } from "../api/client";
import type { RunCaseOut, RunSummaryRow } from "../api/types";

// scores_json/failed_assertions are stored as strings on the wire (parquet
// columns, not nested JSON) -- parsed defensively since a hand-edited or
// pre-schema-change row could still have "" or malformed content.
function parseScores(json: string): [string, number][] {
  try {
    const obj = JSON.parse(json || "{}");
    if (obj && typeof obj === "object") return Object.entries(obj).filter((e): e is [string, number] => typeof e[1] === "number");
  } catch {
    // fall through
  }
  return [];
}

type SortKey = "case_key" | "model_alias" | "passed" | "total_latency_ms" | "ts_utc";
type PassFilter = "all" | "pass" | "fail" | "error";

function effectivePassed(r: RunCaseOut): boolean | null {
  return r.passed_override ?? r.passed;
}

function sortValue(r: RunCaseOut, key: SortKey): string | number {
  if (key === "passed") {
    const p = effectivePassed(r);
    return p === true ? 2 : p === false ? 1 : 0;
  }
  if (key === "total_latency_ms") return r.total_latency_ms ?? -1;
  if (key === "ts_utc") return r.ts_utc;
  return r[key];
}

export default function RunDetailPage() {
  const { runId = null } = useParams<{ runId: string }>();
  const { data: run } = useRun(runId);
  const { data: cases, isLoading } = useRunCases(runId);
  const { data: results } = useRunResults(runId, run?.status === "completed");
  const summary = (results?.summary ?? []) as unknown as RunSummaryRow[];
  const updateAnnotation = useUpdateRunAnnotation();
  const setOverride = useSetCaseOverride();
  const clearOverride = useClearCaseOverride();

  const [detailRow, setDetailRow] = useState<RunCaseOut | null>(null);
  const [packFilter, setPackFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [passFilter, setPassFilter] = useState<PassFilter>("all");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("ts_utc");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selectedCase, setSelectedCase] = useState<string | null>(null);
  const [baseModel, setBaseModel] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);

  const [correctingRow, setCorrectingRow] = useState<RunCaseOut | null>(null);
  const [forceResult, setForceResult] = useState<"" | "pass" | "fail">("");
  const [overrideNote, setOverrideNote] = useState("");

  function openCorrect(row: RunCaseOut) {
    setCorrectingRow(row);
    setForceResult(row.passed_override === true ? "pass" : row.passed_override === false ? "fail" : "");
    setOverrideNote(row.override_note ?? "");
  }

  async function saveOverride() {
    if (!runId || !correctingRow) return;
    if (!overrideNote.trim()) {
      toast("A note explaining the correction is required");
      return;
    }
    try {
      await setOverride.mutateAsync({
        runId,
        recordId: correctingRow.record_id,
        body: {
          passed_override: forceResult === "pass" ? true : forceResult === "fail" ? false : null,
          note: overrideNote.trim(),
        },
      });
      toast("Correction saved");
      setCorrectingRow(null);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed to save correction");
    }
  }

  async function removeOverride() {
    if (!runId || !correctingRow) return;
    try {
      await clearOverride.mutateAsync({ runId, recordId: correctingRow.record_id });
      toast("Correction cleared");
      setCorrectingRow(null);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed to clear correction");
    }
  }

  async function toggleExcluded() {
    if (!runId || !run) return;
    try {
      await updateAnnotation.mutateAsync({ runId, body: { excluded_from_baseline: !run.excluded_from_baseline } });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed to update run");
    }
  }

  async function saveNote() {
    if (!runId) return;
    try {
      await updateAnnotation.mutateAsync({ runId, body: { note: noteDraft ?? run?.note ?? "" } });
      toast("Note saved");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed to save note");
    }
  }

  const packs = useMemo(() => Array.from(new Set(cases?.map((c) => c.pack) ?? [])), [cases]);
  const models = useMemo(() => Array.from(new Set(cases?.map((c) => c.model_alias) ?? [])), [cases]);

  const filtered = useMemo(() => {
    let rows = cases ?? [];
    if (packFilter) rows = rows.filter((r) => r.pack === packFilter);
    if (modelFilter) rows = rows.filter((r) => r.model_alias === modelFilter);
    if (passFilter === "pass") rows = rows.filter((r) => effectivePassed(r) === true);
    if (passFilter === "fail") rows = rows.filter((r) => effectivePassed(r) === false && r.ok);
    if (passFilter === "error") rows = rows.filter((r) => !r.ok);
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      rows = rows.filter((r) => r.case_key.toLowerCase().includes(needle));
    }
    const sorted = [...rows].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    if (sortDir === "desc") sorted.reverse();
    return sorted;
  }, [cases, packFilter, modelFilter, passFilter, search, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }
  function sortArrow(key: SortKey) {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  function openCompare(caseKey: string) {
    setSelectedCase(caseKey);
    setBaseModel(null);
  }

  const compareRows = useMemo(
    () => (cases ?? []).filter((c) => c.case_key === selectedCase).sort((a, b) => a.model_alias.localeCompare(b.model_alias)),
    [cases, selectedCase]
  );
  const base = compareRows.find((r) => r.model_alias === baseModel) ?? compareRows[0];

  return (
    <>
      <div className="topbar">
        <div>
          <h1>
            Run <span className="mono" style={{ fontWeight: 600, fontSize: "0.75em", color: "var(--ink-2)" }}>{runId}</span>
          </h1>
          <p>
            {run ? (
              <>
                <span className={`status ${run.status}`}>
                  <span className="d" />
                  {run.status}
                </span>
                {"  ·  "}
                Launched {fmtDate(run.created_at)}
                {run.finished_at ? ` · finished ${fmtDate(run.finished_at)}` : ""}
                {"  ·  "}
                {run.model_ids.length} model(s) on {run.pack_names.join(", ")}
                {"  ·  "}
                {fmtMoney(run.spend_usd)} spent
                {run.excluded_from_baseline && (
                  <>
                    {"  ·  "}
                    <span className="tag" style={{ color: "var(--critical)" }}>
                      excluded from baseline
                    </span>
                  </>
                )}
              </>
            ) : (
              "Loading run…"
            )}
          </p>
        </div>
        <Link className="btn ghost" to="/runs">
          ← All runs
        </Link>
      </div>
      <div className="content">
        {run && (
          <div className="panel">
            <div style={{ display: "flex", gap: 14, padding: "14px 18px", flexWrap: "wrap", alignItems: "flex-start" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, whiteSpace: "nowrap" }}>
                <input type="checkbox" checked={run.excluded_from_baseline} onChange={toggleExcluded} />
                Exclude from drift baseline
              </label>
              <textarea
                placeholder="Why? (e.g. buggy prompt, provider outage) — shown here for anyone comparing runs later"
                value={noteDraft ?? run.note ?? ""}
                onChange={(e) => setNoteDraft(e.target.value)}
                rows={1}
                style={{ flex: 1, minWidth: 240 }}
              />
              <button className="btn sm ghost" onClick={saveNote} disabled={updateAnnotation.isPending}>
                Save note
              </button>
            </div>
          </div>
        )}

        {summary.length > 0 && (
          <div className="panel">
            <div className="panel-head">
              <h2>Run performance</h2>
              <span className="sub">
                Computed once across every call in this run — read a wide p50→p99 spread alongside the row table
                below to tell a rare slow outlier from a model that's just consistently slow
              </span>
            </div>
            <RunSummaryCharts summary={summary} />
          </div>
        )}

        <div className="panel">
          <div style={{ display: "flex", gap: 10, padding: "14px 18px 0", flexWrap: "wrap" }}>
            <input
              type="text"
              placeholder="Search case key…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 200 }}
            />
            <select value={packFilter} onChange={(e) => setPackFilter(e.target.value)} style={{ width: "auto" }}>
              <option value="">All packs</option>
              {packs.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} style={{ width: "auto" }}>
              <option value="">All models</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select value={passFilter} onChange={(e) => setPassFilter(e.target.value as PassFilter)} style={{ width: "auto" }}>
              <option value="all">Pass + fail + error</option>
              <option value="pass">Passed only</option>
              <option value="fail">Failed only</option>
              <option value="error">Errored only</option>
            </select>
            <span style={{ marginLeft: "auto", alignSelf: "center", fontSize: 12, color: "var(--muted)" }}>
              {filtered.length} of {cases?.length ?? 0} rows
            </span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleSort("case_key")}>
                    Case{sortArrow("case_key")}
                  </th>
                  <th>Pack</th>
                  <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleSort("model_alias")}>
                    Model{sortArrow("model_alias")}
                  </th>
                  <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleSort("passed")}>
                    Result{sortArrow("passed")}
                  </th>
                  <th className="num sortable" style={{ cursor: "pointer" }} onClick={() => toggleSort("total_latency_ms")}>
                    Latency{sortArrow("total_latency_ms")}
                  </th>
                  <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleSort("ts_utc")}>
                    Called at{sortArrow("ts_utc")}
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr>
                    <td colSpan={7} className="empty-hint">
                      Loading…
                    </td>
                  </tr>
                )}
                {!isLoading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty-hint">
                      {cases?.length ? "No rows match this filter." : "No case data for this run yet."}
                    </td>
                  </tr>
                )}
                {filtered.map((r, i) => (
                  <tr key={`${r.case_key}-${r.model_alias}-${r.repeat_index}-${i}`}>
                    <td className="mono" style={{ fontWeight: 600 }}>
                      {r.case_key}
                    </td>
                    <td className="prompt-cell" style={{ maxWidth: 160 }}>
                      {r.pack}
                    </td>
                    <td className="mono">{r.model_alias}</td>
                    <td>
                      {!r.ok ? (
                        <span className="pill off">
                          <span className="d" />
                          error
                        </span>
                      ) : (
                        <span
                          className={`pill ${effectivePassed(r) ? "on" : "off"}`}
                          title={r.passed_override !== null ? `Corrected: ${r.override_note}` : undefined}
                        >
                          <span className="d" />
                          {effectivePassed(r) ? "pass" : "fail"}
                          {r.passed_override !== null && " ✎"}
                        </span>
                      )}
                    </td>
                    <td className="num">{r.total_latency_ms ? `${Math.round(r.total_latency_ms)} ms` : "—"}</td>
                    <td style={{ fontSize: 12, color: "var(--ink-2)" }}>{fmtDate(r.ts_utc)}</td>
                    <td style={{ display: "flex", gap: 6 }}>
                      <button className="btn sm ghost" onClick={() => setDetailRow(r)}>
                        Details
                      </button>
                      <button className="btn sm ghost" onClick={() => openCompare(r.case_key)}>
                        Compare
                      </button>
                      <button className="btn sm ghost" onClick={() => openCorrect(r)}>
                        Correct
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {selectedCase && (
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>
                  Output comparison — <span className="mono">{selectedCase}</span>
                </h2>
                <span className="sub">Diffed word-by-word against the base model's answer</span>
              </div>
              {compareRows.length > 1 && (
                <select value={base?.model_alias ?? ""} onChange={(e) => setBaseModel(e.target.value)} style={{ width: "auto" }}>
                  {compareRows.map((r) => (
                    <option key={r.model_alias} value={r.model_alias}>
                      base: {r.model_alias}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
              {compareRows.map((r) => (
                <div key={r.model_alias}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>
                      {r.model_alias}
                    </span>
                    {r.model_alias === base?.model_alias && (
                      <span className="tag" style={{ fontSize: 10 }}>
                        base
                      </span>
                    )}
                    {!r.ok && (
                      <span className="tag" style={{ fontSize: 10, color: "var(--critical)" }}>
                        {r.error_type || "error"}
                      </span>
                    )}
                  </div>
                  {r.model_alias === base?.model_alias || !base ? (
                    <div className="output-box">{r.response_text || <em style={{ color: "var(--muted)" }}>(empty response)</em>}</div>
                  ) : (
                    <DiffOutput base={base.response_text} text={r.response_text} />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <Drawer
        open={!!detailRow}
        title={detailRow ? `${detailRow.case_key} · ${detailRow.model_alias}` : "Details"}
        onClose={() => setDetailRow(null)}
        footer={
          <button className="btn ghost" onClick={() => setDetailRow(null)}>
            Close
          </button>
        }
      >
        {detailRow && <CaseDetail row={detailRow} />}
      </Drawer>

      <Drawer
        open={!!correctingRow}
        title="Correct result"
        onClose={() => setCorrectingRow(null)}
        width={420}
        footer={
          <>
            {correctingRow?.passed_override !== null && correctingRow?.passed_override !== undefined && (
              <button className="btn ghost" onClick={removeOverride} disabled={clearOverride.isPending}>
                Clear correction
              </button>
            )}
            <button className="btn" onClick={saveOverride} disabled={setOverride.isPending}>
              Save
            </button>
          </>
        }
      >
        {correctingRow && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 13 }}>
              <div className="mono" style={{ fontWeight: 600 }}>
                {correctingRow.case_key}
              </div>
              <div style={{ color: "var(--ink-2)" }}>
                {correctingRow.model_alias} · raw result: {correctingRow.ok ? (correctingRow.passed ? "pass" : "fail") : "error"}
              </div>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Force result
              <select value={forceResult} onChange={(e) => setForceResult(e.target.value as "" | "pass" | "fail")}>
                <option value="">No correction (use raw result)</option>
                <option value="pass">Pass</option>
                <option value="fail">Fail</option>
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Note (required)
              <textarea
                value={overrideNote}
                onChange={(e) => setOverrideNote(e.target.value)}
                rows={3}
                placeholder="Why is this being corrected? e.g. judge mis-scored a valid refusal"
              />
            </label>
          </div>
        )}
      </Drawer>
    </>
  );
}

// The per-row deep dive -- everything the parquet schema captures for one
// call that the flat table has no room for: tokens, cost, real served model
// (an alias can silently point at a different version than requested),
// judge scoring detail, and reliability signals like retries/rate-limiting.
function CaseDetail({ row: r }: { row: RunCaseOut }) {
  const scores = parseScores(r.scores_json);
  const failedAssertions = r.failed_assertions ? r.failed_assertions.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="field">
        <span className="section-label">Result</span>
        {!r.ok ? (
          <span className="pill off">
            <span className="d" />
            error{r.error_type ? `: ${r.error_type}` : ""}
          </span>
        ) : (
          <span className={`pill ${effectivePassed(r) ? "on" : "off"}`}>
            <span className="d" />
            {effectivePassed(r) ? "pass" : "fail"}
            {r.passed_override !== null && " ✎ corrected"}
          </span>
        )}
        {r.error_message && <p className="hint" style={{ marginTop: 6, color: "var(--critical)" }}>{r.error_message}</p>}
      </div>

      <div className="field">
        <span className="section-label">Model actually served</span>
        <p style={{ margin: 0, fontSize: 13 }}>
          {r.vendor || "—"} · <span className="mono">{r.model_served || r.model_alias}</span>
        </p>
        {r.finish_reason && <p className="hint" style={{ margin: "4px 0 0" }}>Finished: {r.finish_reason}</p>}
      </div>

      <div className="field">
        <span className="section-label">Timing</span>
        <p style={{ margin: 0, fontSize: 13 }}>
          TTFT {r.ttft_ms != null ? `${Math.round(r.ttft_ms)} ms` : "—"} · total {r.total_latency_ms != null ? `${Math.round(r.total_latency_ms)} ms` : "—"}
        </p>
      </div>

      <div className="field">
        <span className="section-label">Tokens &amp; cost</span>
        <p style={{ margin: 0, fontSize: 13 }}>
          {r.prompt_tokens ?? "—"} in
          {r.cached_prompt_tokens ? ` (${r.cached_prompt_tokens} cached)` : ""} · {r.completion_tokens ?? "—"} out ·{" "}
          {r.total_tokens ?? "—"} total
        </p>
        <p style={{ margin: "4px 0 0", fontSize: 13 }}>{fmtMoney(r.cost_total_usd)}</p>
      </div>

      {(scores.length > 0 || failedAssertions.length > 0 || r.judge_model) && (
        <div className="field">
          <span className="section-label">Grading detail</span>
          {r.judge_model && <p className="hint" style={{ margin: "0 0 6px" }}>Judge: {r.judge_model}</p>}
          {scores.map(([name, value]) => (
            <p key={name} style={{ margin: "0 0 4px", fontSize: 13, display: "flex", gap: 8 }}>
              <span className="judgepill">{name}</span>
              {value}
            </p>
          ))}
          {failedAssertions.length > 0 && (
            <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--critical)" }}>
              Failed: {failedAssertions.join(", ")}
            </p>
          )}
        </div>
      )}

      {(r.retry_count > 0 || r.rate_limited) && (
        <div className="field">
          <span className="section-label">Reliability</span>
          <p style={{ margin: 0, fontSize: 13 }}>
            {r.retry_count > 0 && `${r.retry_count} retr${r.retry_count > 1 ? "ies" : "y"}`}
            {r.retry_count > 0 && r.rate_limited && " · "}
            {r.rate_limited && "rate-limited"}
          </p>
        </div>
      )}

      <div className="field">
        <span className="section-label">Response</span>
        <div className="output-box">{r.response_text || <em style={{ color: "var(--muted)" }}>(empty response)</em>}</div>
      </div>
    </div>
  );
}

function DiffOutput({ base, text }: { base: string; text: string }) {
  const parts = useMemo(() => diffWords(base, text), [base, text]);
  return (
    <div className="output-box">
      {parts.map((p, i) => (
        <span key={i} className={p.added ? "diff-add" : p.removed ? "diff-del" : undefined}>
          {p.value}
        </span>
      ))}
    </div>
  );
}
