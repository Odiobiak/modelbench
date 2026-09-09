import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useCancelRun, useRuns } from "../api/hooks";
import { fmtDate, fmtMoney } from "../format";
import type { RunOut } from "../api/types";

type SortKey = "created_at" | "calls_done" | "spend_usd";
const STATUSES = ["all", "pending", "running", "completed", "failed", "cancelled"] as const;

export default function RunsPage() {
  const { data: runs, isLoading } = useRuns();
  const cancelRun = useCancelRun();

  const [status, setStatus] = useState<(typeof STATUSES)[number]>("all");
  const [modelFilter, setModelFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const filtered = useMemo(() => {
    let rows = runs ?? [];
    if (status !== "all") rows = rows.filter((r) => r.status === status);
    if (modelFilter.trim()) {
      const needle = modelFilter.trim().toLowerCase();
      rows = rows.filter((r) => r.model_ids.some((m) => m.toLowerCase().includes(needle)));
    }
    const sorted = [...rows].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    if (sortDir === "desc") sorted.reverse();
    return sorted;
  }, [runs, status, modelFilter, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function sortArrow(key: SortKey) {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Runs</h1>
          <p>Every run ever executed. Parquet on disk is the source of truth — this is the index.</p>
        </div>
      </div>
      <div className="content">
        <div className="panel">
          <div style={{ display: "flex", gap: 10, padding: "14px 18px 0", flexWrap: "wrap" }}>
            <select value={status} onChange={(e) => setStatus(e.target.value as (typeof STATUSES)[number])} style={{ width: "auto" }}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? "All statuses" : s}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Filter by model…"
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              style={{ width: 220 }}
            />
            <span style={{ marginLeft: "auto", alignSelf: "center", fontSize: 12, color: "var(--muted)" }}>
              {filtered.length} of {runs?.length ?? 0} runs
            </span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleSort("created_at")}>
                    Run{sortArrow("created_at")}
                  </th>
                  <th>Status</th>
                  <th>Models</th>
                  <th>Packs</th>
                  <th className="num" style={{ cursor: "pointer" }} onClick={() => toggleSort("calls_done")}>
                    Calls{sortArrow("calls_done")}
                  </th>
                  <th className="num" style={{ cursor: "pointer" }} onClick={() => toggleSort("spend_usd")}>
                    Spend{sortArrow("spend_usd")}
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
                {filtered.length === 0 && !isLoading && (
                  <tr>
                    <td colSpan={7} className="empty-hint">
                      {runs?.length ? "No runs match this filter." : "No runs yet — launch one from the Launch run page."}
                    </td>
                  </tr>
                )}
                {filtered.map((r) => (
                  <tr key={r.run_id}>
                    <td>
                      <div style={{ fontSize: 13 }}>{fmtDate(r.created_at)}</div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
                        {r.run_id}
                      </div>
                    </td>
                    <td>
                      <span className={`status ${r.status}`}>
                        <span className="d" />
                        {r.status}
                      </span>
                    </td>
                    <td>
                      {r.model_ids.map((m) => (
                        <span className="tag" key={m}>
                          {m}
                        </span>
                      ))}
                    </td>
                    <td>
                      {r.case_keys?.length ? `${r.case_keys.length} case(s) in ${r.pack_names.join(", ")}` : `${r.pack_names.length} packs`}
                    </td>
                    <td className="num">
                      {(r.calls_done ?? 0).toLocaleString()}
                      {r.total_calls ? ` / ${r.total_calls.toLocaleString()}` : ""}
                    </td>
                    <td className="num">{fmtMoney(r.spend_usd)}</td>
                    <td style={{ display: "flex", gap: 6 }}>
                      <Link className="btn sm ghost" to={`/runs/${r.run_id}`}>
                        View
                      </Link>
                      {(r.status === "pending" || r.status === "running") && (
                        <button className="btn sm ghost" onClick={() => cancelRun.mutate(r.run_id)}>
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function sortValue(r: RunOut, key: SortKey): number {
  if (key === "created_at") return new Date(r.created_at).getTime();
  if (key === "calls_done") return r.calls_done ?? 0;
  return r.spend_usd ?? 0;
}
