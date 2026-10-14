import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Crosshair, Timer, Zap } from "lucide-react";
import { PairAvatar } from "@/components/token-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  confirmDegenArm,
  getArmStatus,
  getDegenVault,
  getKeeperAddress,
  setDegenActive,
  type DegenVaultDTO,
} from "@/lib/degen-api";
import { degenAuthMessage } from "@/lib/degen-auth";
import {
  MAX_ARM_ETH,
  degenChainOk,
  deployValueWei,
  encodeDeployDegen,
  encodeExit,
} from "@/lib/degen-chain";
import { CHECK_INTERVAL_MS, useDegen, type DegenHop } from "@/lib/degen-store";
import { formatApr, formatDuration, formatEth, formatUsd, formatUsdCompact } from "@/lib/format";
import {
  displayPair,
  ethPriceUsd,
  findPool,
  huntApr,
  rankDegen,
  type DegenUniverse,
  type Pool,
} from "@/lib/pools";
import { usePools } from "@/lib/use-pools";
import { isRobinhoodChain, useWallet } from "@/lib/wallet-store";
import { cn } from "@/lib/cn";
import { MIN_ARM_ETH, OPERATOR_STIPEND_ETH } from "@/lib/degen-amounts";

const UNIVERSE: { id: DegenUniverse; label: string }[] = [
  { id: "meme", label: "Memes" },
  { id: "all", label: "All" },
  { id: "stock", label: "Stocks" },
];

function hopsFrom(row: DegenVaultDTO): DegenHop[] {
  return row.hops.map((h) => ({
    id: h.id,
    at: h.at,
    kind: h.kind === "hunt" || h.kind === "pause" ? h.kind : "enter",
    fromPoolId: null,
    toPoolId: h.toPoolId,
    fromPair: h.fromPair,
    toPair: h.toPair,
    fromApr: h.fromApr,
    toApr: h.toApr,
    eth: h.eth,
  }));
}

export function DegenView() {
  const { data } = usePools();
  const pools = data ?? [];
  const px = ethPriceUsd(pools);
  const {
    active,
    live,
    vault,
    eth,
    currentPoolId,
    enteredAt,
    universe,
    lastTick,
    hops,
    depositInput,
    setUniverse,
    setDepositInput,
    applyServer,
    localClear,
  } = useDegen();
  const address = useWallet((s) => s.address);
  const connect = useWallet((s) => s.connect);
  const sendTx = useWallet((s) => s.sendTx);
  const waitReceipt = useWallet((s) => s.waitReceipt);
  const signMessage = useWallet((s) => s.signMessage);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const onchain = live && !!vault;

  const ranked = useMemo(() => rankDegen(pools, universe).filter(degenChainOk), [pools, universe]);
  const current = currentPoolId ? findPool(pools, currentPoolId) : undefined;
  const currentApr = current ? huntApr(current) : 0;
  const usd = eth * px;
  const paused = !active && !!current;
  const nextCheckIn = lastTick ? Math.max(0, lastTick + CHECK_INTERVAL_MS - now) : CHECK_INTERVAL_MS;

  useEffect(() => {
    if (!address) return;
    void getDegenVault({ data: address }).then((row) => {
      if (row) applyServer({ ...row, hops: hopsFrom(row) });
    });
  }, [address, applyServer]);

  useEffect(() => {
    if (!onchain || !address) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
      void getDegenVault({ data: address }).then((row) => {
        if (!row) return;
        const prev = useDegen.getState().currentPoolId;
        applyServer({ ...row, hops: hopsFrom(row) });
        if (row.currentPoolId && row.currentPoolId !== prev) {
          toast.success("The keeper hopped pools.");
        }
      });
    }, 8_000);
    return () => window.clearInterval(id);
  }, [onchain, address, applyServer]);

  useEffect(() => {
    if (!onchain) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [onchain]);

  /** Pause/resume is owner-only: the server checks a wallet signature (no gas, no funds move). */
  async function setActiveSigned(owner: string, nextActive: boolean) {
    const timestamp = Date.now();
    const signature = await signMessage(
      degenAuthMessage(nextActive ? "resume" : "pause", owner, timestamp),
    );
    return setDegenActive({
      data: { owner, active: nextActive, auth: { signature: signature as `0x${string}`, timestamp } },
    });
  }

  async function onArm() {
    if (!address) {
      toast.error("Connect your wallet first.");
      return;
    }
    if (paused) {
      try {
        const row = await setActiveSigned(address, true);
        if (row) applyServer({ ...row, hops: hopsFrom(row) });
        toast.success("Hunter resumed. The keeper hops 24/7.");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Resume rejected");
      }
      return;
    }
    const amount = Number(depositInput);
    if (!Number.isFinite(amount) || amount < MIN_ARM_ETH) {
      toast.error(`Minimum deposit ${MIN_ARM_ETH} ETH, plus ${OPERATOR_STIPEND_ETH} ETH for the keeper and network gas.`);
      return;
    }
    if (amount > MAX_ARM_ETH) {
      toast.error(`Launch cap: ${MAX_ARM_ETH} ETH per vault.`);
      return;
    }
    if (!ranked.length) {
      toast.error("No eligible Uniswap pool in this universe.");
      return;
    }

    if (!isRobinhoodChain(useWallet.getState().chainId)) {
      await useWallet.getState().switchChain();
    }
    setBusy(true);
    try {
      const status = await getArmStatus({ data: address });
      if (!status.allowed) throw new Error("Closed beta: this wallet is not on the allowlist yet.");
      if (status.paused) throw new Error("The keeper is paused for maintenance. Try again later.");
      const keeper = await getKeeperAddress();
      const value = deployValueWei(amount);
      toast.message("Confirm in your wallet. One signature. Then the keeper hops on-chain.");
      const hash = await sendTx({
        data: encodeDeployDegen(keeper.address),
        value: `0x${value.toString(16)}`,
      });
      toast.message("Confirming the vault on-chain…");
      const row = await confirmDegenArm({ data: { hash, owner: address, universe } });
      if (row) applyServer({ ...row, hops: hopsFrom(row) });
      toast.success("Armed on-chain. The keeper handles the hops — you can close the browser.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Arm rejected");
    } finally {
      setBusy(false);
    }
  }

  async function onStop() {
    if (!address) return;
    try {
      const row = await setActiveSigned(address, false);
      if (row) applyServer({ ...row, hops: hopsFrom(row) });
      toast.message("Hunter stopped. Liquidity stays in the last pool.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Pause rejected");
    }
  }

  async function onExit() {
    if (!address || !vault) {
      toast.error("Connect the wallet that armed this vault.");
      return;
    }
    if (!isRobinhoodChain(useWallet.getState().chainId)) {
      await useWallet.getState().switchChain();
    }
    setBusy(true);
    try {
      toast.message("Withdrawing to your wallet. Only you sign.");
      const hash = await sendTx({ to: vault, data: encodeExit() });
      await waitReceipt(hash);
      localClear();
      toast.success("ETH is on the way to your wallet.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Withdraw rejected");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="overflow-hidden rounded-xl bg-surface px-5 py-6 shadow-[var(--shadow-border)] md:px-8 md:py-8">
        <p className="text-xs font-medium tracking-[0.18em] text-accent uppercase">Degen Mode</p>
        <h1 className="mt-2 max-w-xl font-display text-3xl font-semibold tracking-tight md:text-4xl">
          One wallet, one vault. The keeper hops 24/7.
        </h1>
        <p className="mt-3 max-w-lg text-sm text-muted md:text-base">
          Connect your browser wallet and sign once. Each wallet has its own vault —
          funds never mix. The keeper checks every 10 minutes for a meaningfully
          better pool, even with the browser closed.
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]">
        <NestCard
          active={active}
          paused={paused}
          current={current}
          currentApr={currentApr}
          eth={eth}
          usd={usd}
          enteredAt={enteredAt}
          now={now}
          nextCheckIn={nextCheckIn}
          rankedCount={ranked.length}
          onExit={onchain ? () => void onExit() : undefined}
          exiting={busy}
        />

        <section className="rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] md:p-5">
          <h2 className="text-lg font-semibold tracking-tight">Arm the hunter</h2>
          <p className="mt-1 text-sm text-muted">
            {address
              ? "One signature. The keeper — not your wallet — does the hops. You can close the browser."
              : "Connect a wallet to arm the hunter on-chain."}
          </p>

          <label htmlFor="degen-amount" className="mt-4 mb-1 block text-xs font-medium text-muted">
            Deposit (ETH)
          </label>
          <div className="flex items-center gap-3">
            <input
              aria-label="Deposit slider (ETH)"
              type="range"
              min={MIN_ARM_ETH}
              max={MAX_ARM_ETH}
              step={0.00001}
              value={Math.min(Math.max(Number(depositInput) || MIN_ARM_ETH, MIN_ARM_ETH), MAX_ARM_ETH)}
              onChange={(e) => setDepositInput(e.target.value)}
              disabled={active || paused || busy}
              className="h-2 w-full flex-1 accent-[var(--accent)]"
            />
            <input
              id="degen-amount"
              type="number"
              inputMode="decimal"
              min={MIN_ARM_ETH}
              max={MAX_ARM_ETH}
              step={0.00001}
              value={depositInput}
              onChange={(e) => setDepositInput(e.target.value)}
              disabled={active || paused || busy}
              className="w-32 shrink-0 rounded-md bg-surface-2 px-2 py-1.5 text-center font-mono text-sm tabular"
            />
          </div>
          <p className="mt-2 flex justify-between font-mono text-xs text-subtle tabular">
            <span>
              {MIN_ARM_ETH} – {MAX_ARM_ETH} ETH
            </span>
            <span>≈ {formatUsd((Number(depositInput) || 0) * px)}</span>
          </p>

          <div className="mt-3 space-y-1 text-xs text-muted" aria-live="polite">
            <p>Keeper contribution: {formatEth(OPERATOR_STIPEND_ETH, 5)} (added to your deposit).</p>
            <p>
              Total before network gas: {formatEth((Number(depositInput) || 0) + OPERATOR_STIPEND_ETH, 5)}
              {" "}(≈ {formatUsd(((Number(depositInput) || 0) + OPERATOR_STIPEND_ETH) * px)}).
            </p>
            <p>Network gas is extra; check the final total in your wallet. The keeper may need further gas top-ups.</p>
          </div>

          <p className="mt-5 mb-2 text-xs font-medium text-muted">Universe</p>
          <div className="grid grid-cols-3 gap-1.5">
            {UNIVERSE.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => setUniverse(u.id)}
                className={cn(
                  "h-10 rounded-sm text-xs font-medium",
                  universe === u.id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg",
                )}
              >
                {u.label}
              </button>
            ))}
          </div>

          <div className="mt-5 flex flex-col gap-2">
            {active ? (
              <Button variant="danger" onClick={() => void onStop()}>
                Stop hunter
              </Button>
            ) : (
              <Button onClick={() => void onArm()} disabled={busy}>
                <Zap className="size-4" />
                {busy ? "Arming…" : paused ? "Resume hunter" : "Arm on-chain"}
              </Button>
            )}
            {!address ? (
              <Button variant="secondary" onClick={() => void connect()} disabled={busy}>
                Connect wallet
              </Button>
            ) : null}
          </div>
          <p className="mt-3 text-xs text-subtle">
            On-chain only, Uniswap v3 ETH pairs. One wallet = one vault. Impermanent
            loss applies and a token that cannot be sold is handed to you as-is.
          </p>
        </section>
      </div>

      <HuntBoard ranked={ranked} currentId={currentPoolId} />

      <HopLog hops={hops} />
    </div>
  );
}

function NestCard({
  active,
  paused,
  current,
  currentApr,
  eth,
  usd,
  enteredAt,
  now,
  nextCheckIn,
  rankedCount,
  onExit,
  exiting,
}: {
  active: boolean;
  paused: boolean;
  current?: Pool;
  currentApr: number;
  eth: number;
  usd: number;
  enteredAt: number;
  now: number;
  nextCheckIn: number;
  rankedCount: number;
  onExit?: () => void;
  exiting?: boolean;
}) {
  if (!current) {
    return (
      <section className="flex flex-col items-center justify-center rounded-xl bg-surface px-6 py-16 text-center shadow-[var(--shadow-border)]">
        <Crosshair className="size-8 text-subtle" />
        <h2 className="mt-4 text-lg font-semibold">No nest yet</h2>
        <p className="mt-1 max-w-sm text-sm text-muted">
          Arm Degen. It picks the highest-APR pool among {rankedCount}{" "}
          candidates and hops on its own from there.
        </p>
      </section>
    );
  }

  const inNest = now - enteredAt;

  return (
    <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <PairAvatar
            a={current.tokenA.symbol}
            b={current.tokenB.symbol}
            addrA={current.tokenA.address}
            addrB={current.tokenB.address}
            imageA={current.imageA}
            imageB={current.imageB}
          />
          <div>
            <p className="text-xs tracking-wide text-subtle uppercase">Current nest</p>
            <h2 className="font-display text-2xl font-semibold tracking-tight">
              {displayPair(current)}
            </h2>
          </div>
        </div>
        {active ? (
          <Badge tone="up" className="gap-1.5">
            <span className="live-dot" />
            On-chain
          </Badge>
        ) : (
          <Badge>Stopped in this pool</Badge>
        )}
      </div>

      <p className="mt-5 font-mono text-4xl font-medium tracking-tight text-accent tabular">
        {formatApr(currentApr)}
      </p>
      <p className="text-xs text-muted">Chase APR · 1h volume annualized</p>

      <dl className="mt-5 grid grid-cols-2 gap-2 text-sm">
        <Stat label="ETH" value={formatEth(eth, 4)} />
        <Stat label="Value" value={formatUsd(usd)} />
      </dl>
      <p className="mt-3 flex items-center gap-2 text-xs text-muted">
        <Timer className="size-3.5" />
        In this pool for {formatDuration(inNest)}
      </p>

      {paused ? (
        <p className="mt-5 rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
          Hunter stopped. Liquidity stays here. Resume to hop again.
        </p>
      ) : (
        <p className="mt-5 rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
          Next check in {formatDuration(nextCheckIn)}.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button asChild variant="secondary" size="sm">
          <Link to="/pool/$poolId" params={{ poolId: current.id }}>
            View pool
          </Link>
        </Button>
        {onExit ? (
          <Button variant="danger" size="sm" onClick={onExit} disabled={exiting}>
            {exiting ? "Withdrawing…" : "Withdraw to wallet"}
          </Button>
        ) : null}
      </div>
      {onExit ? (
        <p className="mt-2 text-xs text-subtle">Only the wallet that armed can withdraw. One signature.</p>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2">
      <dt className="text-[11px] text-subtle">{label}</dt>
      <dd className="font-mono tabular">{value}</dd>
    </div>
  );
}

function HuntBoard({ ranked, currentId }: { ranked: Pool[]; currentId: string | null }) {
  const rows = ranked.slice(0, 16);
  return (
    <section className="rounded-xl bg-surface shadow-[var(--shadow-border)]">
      <div className="flex items-end justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight">APR hunt</h2>
          <p className="text-xs text-muted">Live ranking, rechecked every 10 minutes.</p>
        </div>
        <p className="text-xs text-subtle">{ranked.length} pools</p>
      </div>

      <div className="hidden md:block">
        <div className="grid grid-cols-[2.2rem_1.6fr_0.8fr_0.8fr_0.7fr] gap-2 px-5 pb-2 text-[11px] tracking-wide text-subtle uppercase">
          <span>#</span>
          <span>Pool</span>
          <span className="text-right">APR chase</span>
          <span className="text-right">TVL</span>
          <span className="text-right">Vol 24h</span>
        </div>
        <ul>
          {rows.map((p, i) => {
            const mine = p.id === currentId;
            return (
              <li key={p.id} className="border-t border-border">
                <Link
                  to="/pool/$poolId"
                  params={{ poolId: p.id }}
                  className={cn(
                    "grid grid-cols-[2.2rem_1.6fr_0.8fr_0.8fr_0.7fr] items-center gap-2 px-5 py-3 hover:bg-surface-2",
                    mine && "bg-accent/10",
                  )}
                >
                  <span className="font-mono text-xs text-subtle tabular">{i + 1}</span>
                  <span className="flex min-w-0 items-center gap-3">
                    <PairAvatar
                      a={p.tokenA.symbol}
                      b={p.tokenB.symbol}
                      addrA={p.tokenA.address}
                      addrB={p.tokenB.address}
                      imageA={p.imageA}
                      imageB={p.imageB}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{displayPair(p)}</span>
                      <span className="block text-xs text-subtle">
                        {p.version} · {p.feePct}%{mine ? " · nest" : ""}
                      </span>
                    </span>
                  </span>
                  <span className="text-right font-mono text-sm text-accent tabular">
                    {formatApr(huntApr(p))}
                  </span>
                  <span className="text-right font-mono text-sm tabular">
                    {formatUsdCompact(p.tvlUsd)}
                  </span>
                  <span className="text-right font-mono text-sm tabular">
                    {formatUsdCompact(p.volume24h)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      <ul className="flex flex-col gap-0 md:hidden">
        {rows.map((p, i) => {
          const mine = p.id === currentId;
          return (
            <li key={p.id} className="border-t border-border">
              <Link
                to="/pool/$poolId"
                params={{ poolId: p.id }}
                className={cn("flex items-center justify-between gap-3 px-4 py-3", mine && "bg-accent/10")}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="w-5 font-mono text-xs text-subtle tabular">{i + 1}</span>
                  <PairAvatar
                    a={p.tokenA.symbol}
                    b={p.tokenB.symbol}
                    addrA={p.tokenA.address}
                    addrB={p.tokenB.address}
                    imageA={p.imageA}
                    imageB={p.imageB}
                  />
                  <span className="truncate font-medium">{displayPair(p)}</span>
                </span>
                <span className="font-mono text-sm text-accent tabular">{formatApr(huntApr(p))}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted">No Uniswap pool matches this universe.</p>
      ) : null}
    </section>
  );
}

function HopLog({ hops }: { hops: DegenHop[] }) {
  if (!hops.length) return null;
  return (
    <section className="rounded-xl bg-surface px-5 py-4 shadow-[var(--shadow-border)]">
      <h2 className="font-display text-lg font-semibold tracking-tight">Hop log</h2>
      <ol className="mt-3 flex flex-col">
        {hops.map((h) => (
          <li
            key={h.id}
            className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border py-3 text-sm"
          >
            <span>
              <span className="text-muted">
                {h.kind === "enter" ? "Entered" : h.kind === "hunt" ? "Hopped to" : "Stopped in"}{" "}
              </span>
              <span className="font-medium">{h.toPair}</span>
              {h.kind === "hunt" && h.fromPair ? (
                <span className="text-subtle"> ← {h.fromPair}</span>
              ) : null}
            </span>
            <span className="font-mono text-xs text-muted tabular">
              {h.kind === "hunt" ? (
                <>
                  {formatApr(h.fromApr)} → {formatApr(h.toApr)}
                </>
              ) : (
                formatApr(h.toApr)
              )}
              {" · "}
              {formatEth(h.eth, 4)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
