import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { diffWords } from "diff";
import { useRun, useRunCases } from "../api/hooks";
import { fmtDate, fmtMoney } from "../format";
import type { RunCaseOut } from "../api/types";

type SortKey = "case_key" | "model_alias" | "passed" | "total_latency_ms" | "ts_utc";
type PassFilter = "all" | "pass" | "fail" | "error";

function sortValue(r: RunCaseOut, key: SortKey): string | number {
  if (key === "passed") return r.passed === true ? 2 : r.passed === false ? 1 : 0;
  if (key === "total_latency_ms") return r.total_latency_ms ?? -1;
  if (key === "ts_utc") return r.ts_utc;
  return r[key];
}

export default function RunDetailPage() {
  const { runId = null } = useParams<{ runId: string }>();
  const { data: run } = useRun(runId);
  const { data: cases, isLoading } = useRunCases(runId);

  const [packFilter, setPackFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [passFilter, setPassFilter] = useState<PassFilter>("all");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("ts_utc");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selectedCase, setSelectedCase] = useState<string | null>(null);
  const [baseModel, setBaseModel] = useState<string | null>(null);

  const packs = useMemo(() => Array.from(new Set(cases?.map((c) => c.pack) ?? [])), [cases]);
  const models = useMemo(() => Array.from(new Set(cases?.map((c) => c.model_alias) ?? [])), [cases]);

  const filtered = useMemo(() => {
    let rows = cases ?? [];
    if (packFilter) rows = rows.filter((r) => r.pack === packFilter);
    if (modelFilter) rows = rows.filter((r) => r.model_alias === modelFilter);
    if (passFilter === "pass") rows = rows.filter((r) => r.passed === true);
    if (passFilter === "fail") rows = rows.filter((r) => r.passed === false && r.ok);
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
                        <span className={`pill ${r.passed ? "on" : "off"}`}>
                          <span className="d" />
                          {r.passed ? "pass" : "fail"}
                        </span>
                      )}
                    </td>
                    <td className="num">{r.total_latency_ms ? `${Math.round(r.total_latency_ms)} ms` : "—"}</td>
                    <td style={{ fontSize: 12, color: "var(--ink-2)" }}>{fmtDate(r.ts_utc)}</td>
                    <td>
                      <button className="btn sm ghost" onClick={() => openCompare(r.case_key)}>
                        Compare
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
    </>
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
