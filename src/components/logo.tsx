export function PerchMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 22.5h24"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M10 22.5c.4-5.2 3.4-9.6 8.6-11.2 1.6-.5 3.4-.4 4.6.8-2.2 1.4-3.4 3.6-3.6 6.4 2.2-.6 4.2.2 5.8 1.8-3.8.4-7.2 1.2-11.2 2.2-1.4.4-2.8.2-4.2 0Z"
        fill="currentColor"
      />
      <circle cx="20.4" cy="12.2" r="0.9" fill="var(--color-bg)" />
    </svg>
  );
}

export function PerchWordmark() {
  return (
    <span className="flex items-center gap-2 text-fg">
      <PerchMark className="size-7 text-accent" />
      <span className="font-display text-lg font-semibold tracking-tight">Perch</span>
    </span>
  );
}
