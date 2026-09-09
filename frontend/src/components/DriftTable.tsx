import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { DriftAlert } from "../api/types";

const ICONS: Record<string, ReactElement> = {
  critical: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9L2.5 18a2 2 0 001.8 3h15.4a2 2 0 001.8-3L13.7 3.9a2 2 0 00-3.4 0z" />
    </svg>
  ),
  serious: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path d="M12 6v6l4 2" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  ),
  good: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  ),
};

const SEVERITY_RANK: Record<string, number> = { critical: 0, serious: 1, good: 2 };

type SortKey = "model" | "metric" | "severity" | "delta";

function sortValue(a: DriftAlert, key: SortKey): string | number {
  if (key === "severity") return SEVERITY_RANK[a.severity] ?? 3;
  if (key === "delta") {
    const m = a.delta.match(/-?[\d.]+/);
    return m ? parseFloat(m[0]) : 0;
  }
  return a[key];
}

export default function DriftTable({ alerts, onSelect }: { alerts: DriftAlert[]; onSelect?: (model: string) => void }) {
  const [sortKey, setSortKey] = useState<SortKey>("severity");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sorted = useMemo(() => {
    const rows = [...alerts].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    if (sortDir === "desc") rows.reverse();
    return rows;
  }, [alerts, sortKey, sortDir]);

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

  if (!alerts.length) {
    return <p className="empty-hint">No metric moved more than 10% against its baseline.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleSort("model")}>
            Model{sortArrow("model")}
          </th>
          <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleSort("metric")}>
            Metric{sortArrow("metric")}
          </th>
          <th>Before</th>
          <th>After</th>
          <th className="sortable" style={{ cursor: "pointer" }} onClick={() => toggleSort("severity")}>
            Severity{sortArrow("severity")}
          </th>
          <th className="num sortable" style={{ cursor: "pointer" }} onClick={() => toggleSort("delta")}>
            Change{sortArrow("delta")}
          </th>
          <th>What it means</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((a) => (
          <tr key={`${a.model}-${a.metric}`} onClick={() => onSelect?.(a.model)} style={onSelect ? { cursor: "pointer" } : undefined}>
            <td className="mono" style={{ fontWeight: 600 }}>
              {a.model}
            </td>
            <td>{a.metric}</td>
            <td className="mono" style={{ color: "var(--ink-2)" }}>
              {a.before}
            </td>
            <td className="mono">{a.after}</td>
            <td>
              <span className={`sev ${a.severity}`}>{ICONS[a.severity]}</span>
            </td>
            <td className="num mono">{a.delta}</td>
            <td style={{ whiteSpace: "normal", color: "var(--ink-2)", fontSize: 12.5, minWidth: 260 }}>{a.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
