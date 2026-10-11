import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Badge({
  className,
  tone = "neutral",
  children,
}: {
  className?: string;
  tone?: "neutral" | "up" | "down" | "accent";
  children: ReactNode;
}) {
  const tones = {
    neutral: "bg-surface-2 text-muted",
    up: "bg-accent/12 text-accent",
    down: "bg-down/12 text-down",
    accent: "bg-accent text-accent-fg",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-medium tracking-wide",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
