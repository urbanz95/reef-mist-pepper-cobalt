import type { Pool } from "@/lib/pools";
import { formatNum } from "@/lib/format";

export function RangeVisual({
  pool,
  pMin,
  pMax,
  full,
}: {
  pool: Pool;
  pMin: number;
  pMax: number;
  full?: boolean;
}) {
  const price = pool.priceUsd || 1;
  const lo = full ? price * 0.5 : Math.min(pMin, price * 0.7);
  const hi = full ? price * 1.5 : Math.max(pMax, price * 1.3);
  const span = hi - lo || 1;
  const x = (v: number) => ((v - lo) / span) * 100;
  const left = full ? 4 : Math.max(0, x(pMin));
  const right = full ? 96 : Math.min(100, x(pMax));
  const width = Math.max(4, right - left);
  const px = Math.min(100, Math.max(0, x(price)));

  const bars = Array.from({ length: 28 }, (_, i) => {
    const t = i / 27;
    const p = lo + t * span;
    const inBand = full || (p >= pMin && p <= pMax);
    const dist = Math.abs(p - price) / price;
    const h = inBand ? 18 + Math.max(0, 42 - dist * 180) : 10;
    return { i, h, inBand };
  });

  return (
    <div className="rounded-lg bg-surface-2 p-4">
      <div className="mb-3 flex items-end justify-between text-xs text-muted">
        <span>Min {full ? "0" : formatNum(pMin, 4)}</span>
        <span className="font-mono text-fg tabular">{formatNum(price, 4)} {pool.tokenB.symbol}</span>
        <span>Max {full ? "∞" : formatNum(pMax, 4)}</span>
      </div>
      <svg viewBox="0 0 280 72" className="h-20 w-full" aria-hidden="true">
        {bars.map((b) => (
          <rect
            key={b.i}
            x={4 + b.i * 9.8}
            y={66 - b.h}
            width="6.4"
            height={b.h}
            rx="1.4"
            fill={b.inBand ? "var(--color-accent)" : "var(--color-subtle)"}
            opacity={b.inBand ? 0.85 : 0.35}
          />
        ))}
        <rect
          x={(left / 100) * 280}
          y="2"
          width={(width / 100) * 280}
          height="68"
          fill="var(--color-accent)"
          opacity="0.08"
        />
        <line
          x1={(px / 100) * 280}
          x2={(px / 100) * 280}
          y1="0"
          y2="72"
          stroke="var(--color-fg)"
          strokeWidth="1.4"
          strokeDasharray="3 3"
        />
      </svg>
      <p className="mt-2 text-center text-[11px] text-subtle">
        Current price · concentrated liquidity in the selected range
      </p>
    </div>
  );
}
