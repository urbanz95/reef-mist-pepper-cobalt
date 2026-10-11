import * as React from "react";
import { cn } from "@/lib/cn";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      suppressHydrationWarning
      className={cn(
        "h-11 w-full rounded-md bg-bg px-3 text-base text-fg shadow-[var(--shadow-border)] tabular outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-accent/60 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}
