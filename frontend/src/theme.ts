// Kept in sync with the inline script in index.html, which sets the
// attribute before first paint using the same storage key and fallback so
// there's no flash of the wrong theme on load.
const STORAGE_KEY = "modelbench-theme";

export type Theme = "light" | "dark";

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function getTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* localStorage unavailable (private mode, etc.) -- fall through */
  }
  return systemPrefersDark() ? "dark" : "light";
}

export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* not persisted this session, but the attribute is still set */
  }
}
