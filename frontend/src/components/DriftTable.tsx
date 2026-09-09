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

export default function DriftTable({ alerts, onSelect }: { alerts: DriftAlert[]; onSelect?: (model: string) => void }) {
  if (!alerts.length) {
    return <p className="empty-hint">No metric moved more than 10% against its baseline.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Model</th>
          <th>Metric</th>
          <th>Before</th>
          <th>After</th>
          <th>Change</th>
          <th>What it means</th>
        </tr>
      </thead>
      <tbody>
        {alerts.map((a, i) => (
          <tr key={i} onClick={() => onSelect?.(a.model)} style={onSelect ? { cursor: "pointer" } : undefined}>
            <td className="mono" style={{ fontWeight: 600 }}>
              {a.model}
            </td>
            <td>{a.metric}</td>
            <td className="mono" style={{ color: "var(--ink-2)" }}>
              {a.before}
            </td>
            <td className="mono">{a.after}</td>
            <td>
              <span className={`sev ${a.severity}`}>
                {ICONS[a.severity]}
                {a.delta}
              </span>
            </td>
            <td style={{ whiteSpace: "normal", color: "var(--ink-2)", fontSize: 12.5, minWidth: 260 }}>{a.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
