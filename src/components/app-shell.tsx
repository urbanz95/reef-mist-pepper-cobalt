import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { LayoutGrid, Layers, Zap } from "lucide-react";
import { PerchWordmark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { WalletButton } from "@/components/wallet-button";
import { cn } from "@/lib/cn";
import { useTheme } from "@/lib/theme";

const NAV = [
  { to: "/", label: "Markets", icon: LayoutGrid },
  { to: "/degen", label: "Degen", icon: Zap },
  { to: "/positions", label: "Positions", icon: Layers },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const theme = useTheme((s) => s.theme);

  return (
    <div
      className={cn(
        "flex min-h-dvh flex-col bg-bg text-fg",
        theme === "light" ? "light" : "dark",
      )}
      data-theme={theme}
    >
      <header className="sticky top-0 z-40 border-b border-border bg-bg backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4">
          <Link to="/" className="shrink-0" aria-label="Perch, home">
            <PerchWordmark />
          </Link>
          <nav className="hidden items-center gap-1 md:flex">
            {NAV.map((item) => {
              const active = pathname === item.to;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "flex h-11 items-center rounded-md px-4 text-sm font-medium transition-colors",
                    active ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center gap-1 sm:gap-2">
            <ThemeToggle />
            <WalletButton />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-24 md:pb-10">{children}</main>

      <footer className="hidden border-t border-border px-4 py-6 text-xs text-subtle md:block">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <p>Perch — Uniswap liquidity on Robinhood Chain. Not affiliated with Robinhood Markets, Inc.</p>
          <p>Degen only hops pools. Your wallet stays in control. Impermanent loss applies.</p>
        </div>
      </footer>

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg md:hidden">
        <div className="grid grid-cols-3">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium",
                  active ? "text-accent" : "text-muted",
                )}
              >
                <Icon className="size-5" />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
