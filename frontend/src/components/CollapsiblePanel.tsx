import { useState, type CSSProperties, type ReactNode } from "react";

const STORAGE_PREFIX = "modelbench-collapsed:";

// Collapsed state is per-panel (keyed by `id`) and persists across visits --
// once someone collapses a section they've already read, it should stay
// collapsed next time they land on the page, not reappear and cost them the
// same scroll again. Falls back to `defaultCollapsed` (and just stops
// persisting) if localStorage is unavailable, e.g. a private window.
function readStored(id: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(STORAGE_PREFIX + id);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

/**
 * A `.panel` whose whole head toggles its body -- the same chevron-rotate
 * pattern RunLauncherPanel already uses for its provider groups, generalized
 * into a standalone wrapper so any page can turn a heavy section into
 * "collapsed until asked for" instead of permanent scroll weight.
 */
export default function CollapsiblePanel({
  id,
  title,
  sub,
  defaultCollapsed = false,
  onToggle,
  headExtra,
  children,
  style,
}: {
  id: string;
  title: string;
  sub?: ReactNode;
  defaultCollapsed?: boolean;
  /** Notified on every toggle -- for a caller that also needs the collapsed
   * state itself (e.g. to skip fetching/rendering heavy content while
   * collapsed), rather than trusting `{!collapsed && children}` alone. */
  onToggle?: (collapsed: boolean) => void;
  headExtra?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const [collapsed, setCollapsed] = useState(() => readStored(id, defaultCollapsed));

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_PREFIX + id, next ? "1" : "0");
      } catch {
        // Collapse still works for this render, just doesn't persist.
      }
      onToggle?.(next);
      return next;
    });
  }

  return (
    <div className="panel" style={style}>
      <div className={`panel-head collapsible-head${collapsed ? " collapsed" : ""}`} onClick={toggle}>
        <div>
          <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              style={{ width: 11, height: 11, color: "var(--muted)", flex: "none", transform: collapsed ? "rotate(-90deg)" : undefined }}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
            {title}
          </h2>
          {sub && <span className="sub">{sub}</span>}
        </div>
        {headExtra && <span onClick={(e) => e.stopPropagation()}>{headExtra}</span>}
      </div>
      {!collapsed && children}
    </div>
  );
}
