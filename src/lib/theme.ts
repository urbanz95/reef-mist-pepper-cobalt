import { create } from "zustand";

export type Theme = "light" | "dark";

export const THEME_KEY = "perch-theme";

export function readTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  if (document.documentElement.classList.contains("light")) return "light";
  return "dark";
}

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("light", theme === "light");
  root.classList.toggle("dark", theme === "dark");
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.body.classList.toggle("light", theme === "light");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#f3f5f1" : "#0b0d0c");
  window.localStorage.setItem(THEME_KEY, theme);
}

type ThemeState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
};

export const useTheme = create<ThemeState>((set, get) => ({
  theme: "dark",
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  toggle: () => {
    const now =
      typeof document !== "undefined" && document.documentElement.classList.contains("light")
        ? "light"
        : get().theme;
    const next: Theme = now === "dark" ? "light" : "dark";
    applyTheme(next);
    set({ theme: next });
  },
}));

export function hydrateTheme() {
  const theme = readTheme();
  applyTheme(theme);
  useTheme.setState({ theme });
}
