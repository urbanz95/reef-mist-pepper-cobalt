function withThousands(intPart: string) {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function dec(n: number, digits: number) {
  const fixed = Math.abs(n).toFixed(digits);
  const [i, f] = fixed.split(".");
  const body = f ? `${withThousands(i)},${f}` : withThousands(i);
  return n < 0 ? `-${body}` : body;
}

export function formatUsd(value: number, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${dec(n, digits)} $`;
}

export function formatUsdCompact(value: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}${dec(abs / 1_000_000_000, 2)} mil M$`;
  if (abs >= 1_000_000) return `${sign}${dec(abs / 1_000_000, 2)} M$`;
  if (abs >= 1_000) return `${sign}${dec(abs / 1_000, 2)} mil $`;
  return formatUsd(n, abs >= 1 ? 2 : 4);
}

export function formatPct(value: number, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits).replace(".", ",")}%`;
}

export function formatApr(value: number, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const d = abs >= 1000 ? 0 : abs >= 100 ? 1 : digits;
  return `${n.toFixed(d).replace(".", ",")}%`;
}

export function formatNum(value: number, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const d = abs >= 1000 ? 2 : abs >= 1 ? Math.min(digits, 4) : digits;
  return dec(n, d);
}

export function formatEth(value: number, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${dec(n, digits)} ETH`;
}

export function formatDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatAddress(address: string) {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatAge(iso: string, nowMs: number) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "New";
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function tokenHue(address: string) {
  let h = 0;
  for (let i = 0; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) >>> 0;
  return h % 360;
}
