import { useEffect } from "react";
import { Moon, Sun } from "lucide-react";
import { hydrateTheme, useTheme } from "@/lib/theme";

export function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const toggle = useTheme((s) => s.toggle);

  useEffect(() => {
    hydrateTheme();
  }, []);

  const light = theme === "light";

  return (
    <button
      type="button"
      onClick={() => toggle()}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
      aria-label={light ? "Switch to dark mode" : "Switch to light mode"}
      aria-pressed={light}
    >
      {light ? <Moon className="size-5" /> : <Sun className="size-5" />}
    </button>
  );
}
