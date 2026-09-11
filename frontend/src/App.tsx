import { useEffect, useState, type ReactElement } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import ToastHost from "./components/ToastHost";
import ModelsPage from "./pages/ModelsPage";
import ModelGuidePage from "./pages/ModelGuidePage";
import CasesPage from "./pages/CasesPage";
import LaunchPage from "./pages/LaunchPage";
import RunsPage from "./pages/RunsPage";
import RunDetailPage from "./pages/RunDetailPage";
import RunComparePage from "./pages/RunComparePage";
import ExplorerPage from "./pages/ExplorerPage";
import DashboardPage from "./pages/DashboardPage";
import SettingsPage from "./pages/SettingsPage";
import { usePacks, useModels, useRuns } from "./api/hooks";
import { getTheme, setTheme, type Theme } from "./theme";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8811";

function NavItem({ to, icon, label, count }: { to: string; icon: ReactElement; label: string; count?: number }) {
  return (
    <NavLink to={to} className={({ isActive }) => `navitem${isActive ? " active" : ""}`}>
      {icon}
      {label}
      {count !== undefined && <span className="count">{count}</span>}
    </NavLink>
  );
}

export default function App() {
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const { data: models } = useModels();
  const { data: packs } = usePacks();
  const { data: runs } = useRuns();

  useEffect(() => {
    fetch(`${API_BASE}/health`)
      .then((r) => setHealthy(r.ok))
      .catch(() => setHealthy(false));
  }, []);

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  }

  const totalCases = packs?.reduce((sum, p) => sum + p.case_count, 0) ?? 0;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="mark">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M4 18V10M12 18V6M20 18V13" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </span>
          <span className="word">
            model<b>bench</b>
          </span>
        </div>
        <nav>
          <span className="navlabel">Bench</span>
          <NavItem
            to="/models"
            count={models?.length}
            label="Models"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M3 9h18M9 9v11" />
              </svg>
            }
          />
          <NavItem
            to="/guide"
            label="Model guide"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
              </svg>
            }
          />
          <NavItem
            to="/cases"
            count={totalCases}
            label="Test cases"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M9 3h6l1 4H8l1-4zM6 7h12l1 13a1 1 0 01-1 1H6a1 1 0 01-1-1L6 7z" />
                <path d="M9 12h6M9 16h4" />
              </svg>
            }
          />
          <NavItem
            to="/launch"
            label="Launch run"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M5 3l16 9-16 9V3z" />
              </svg>
            }
          />
          <NavItem
            to="/runs"
            count={runs?.length}
            label="Runs"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3.5 2" />
              </svg>
            }
          />
          <span className="navlabel">Insights</span>
          <NavItem
            to="/"
            label="Dashboard"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M3 17l5-6 4 4 5-8 4 5" />
              </svg>
            }
          />
          <NavItem
            to="/explorer"
            label="Explorer"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
            }
          />
          <span className="navlabel">Config</span>
          <NavItem
            to="/settings"
            label="Settings"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" />
              </svg>
            }
          />
        </nav>
        <div className="sidefoot">
          <button className="themetoggle" onClick={toggleTheme} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
            {theme === "dark" ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
              </svg>
            )}
            {theme === "dark" ? "Light theme" : "Dark theme"}
          </button>
          <span>
            <span className={healthy ? "dot-live" : "dot-off"} />
            &nbsp;{healthy === null ? "checking API…" : healthy ? "API reachable" : "API unreachable"}
          </span>
        </div>
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/guide" element={<ModelGuidePage />} />
          <Route path="/cases" element={<CasesPage />} />
          <Route path="/launch" element={<LaunchPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/compare" element={<RunComparePage />} />
          <Route path="/runs/:runId" element={<RunDetailPage />} />
          <Route path="/explorer" element={<ExplorerPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <ToastHost />
    </div>
  );
}
