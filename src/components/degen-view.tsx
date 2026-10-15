import { useEffect, useState } from "react";
import { toast } from "sonner";
import { encodeFunctionData } from "viem";
import { Button } from "./ui/button";
import { DegenSimulator } from "./degen-simulator";
import {
  confirmDegenArm,
  getArmStatus,
  getDegenReadiness,
  getDegenVault,
  getKeeperAddress,
  setDegenActive,
  type DegenVaultDTO,
} from "@/lib/degen-api";
import { degenAuthMessage, isAddress } from "@/lib/degen-auth";
import {
  deployValueWei,
  encodeDeployDegen,
  encodeExit,
  prepareExit,
  readVault,
  MAX_ARM_ETH,
} from "@/lib/degen-chain";
import { DEGEN_ABI } from "@/lib/degen-artifact";
import { MIN_ARM_ETH, OPERATOR_STIPEND_ETH } from "@/lib/degen-amounts";
import { explorerAddress, explorerTx } from "@/lib/chain";
import { isRobinhoodChain, useWallet } from "@/lib/wallet-store";

type PendingArm = { hash: string; owner: string; universe: "all" };
export function DegenView() {
  const wallet = useWallet();
  const [row, setRow] = useState<DegenVaultDTO | null>(null);
  const [ready, setReady] = useState<{ ready: boolean; reason: string | null; tokens: string[] }>({
    ready: false,
    reason: "Checking readiness…",
    tokens: [],
  });
  const [amount, setAmount] = useState(String(MIN_ARM_ETH));
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingArm | null>(null);
  const [recovery, setRecovery] = useState("");
  const [rescueToken, setRescueToken] = useState("");
  const [quote, setQuote] = useState<Awaited<ReturnType<typeof prepareExit>> | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let cancelled = false;
    const check = () =>
      void getDegenReadiness()
        .then((r) => {
          if (!cancelled) setReady(r);
        })
        .catch(() => {
          if (!cancelled)
            setReady({
              ready: false,
              reason: "Readiness unavailable; deposits disabled.",
              tokens: [],
            });
        });
    check();
    const timer = setInterval(check, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setRow(null);
    setQuote(null);
    setLastTx(null);
    setPending(null);
    if (!wallet.address) return;
    const owner = wallet.address;
    try {
      const stored = localStorage.getItem(`perch.pending-arm.${owner.toLowerCase()}`);
      if (stored) setPending(JSON.parse(stored));
    } catch {}
    const refresh = () =>
      void getDegenVault({ data: owner })
        .then((r) => {
          if (!cancelled && r) setRow(r);
        })
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [wallet.address]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }
  async function network() {
    if (!isRobinhoodChain(useWallet.getState().chainId)) await wallet.switchChain();
  }
  async function recoverArm(p: PendingArm) {
    const r = await confirmDegenArm({ data: p });
    if (useWallet.getState().address?.toLowerCase() !== p.owner.toLowerCase()) return;
    if (!r) throw new Error("Vault registration unavailable; keep the deployment hash.");
    setRow(r);
    setPending(null);
    localStorage.removeItem(`perch.pending-arm.${p.owner.toLowerCase()}`);
    toast.success("Vault registered. Check its monitoring status below.");
  }
  async function arm() {
    if (!wallet.address) throw new Error("Connect your wallet first.");
    const owner = wallet.address;
    const status = await getArmStatus({ data: owner });
    if (!status.ready) throw new Error(status.reason ?? "Deposits disabled.");
    if (!status.allowed) throw new Error("Wallet is not on the beta allowlist.");
    if (row || pending) throw new Error("Recover or withdraw the existing vault first.");
    const value = Number(amount);
    if (!Number.isFinite(value) || value < MIN_ARM_ETH || value > MAX_ARM_ETH)
      throw new Error(`Deposit must be ${MIN_ARM_ETH}–${MAX_ARM_ETH} ETH.`);
    await network();
    const keeper = await getKeeperAddress();
    const hash = await wallet.sendTx({
      data: encodeDeployDegen(keeper.address, status.tokens),
      value: `0x${deployValueWei(value).toString(16)}`,
    });
    const p: PendingArm = { hash, owner, universe: "all" };
    localStorage.setItem(`perch.pending-arm.${owner.toLowerCase()}`, JSON.stringify(p));
    setPending(p);
    await recoverArm(p);
  }
  async function verifyOwner() {
    if (!row || !wallet.address || row.owner.toLowerCase() !== wallet.address.toLowerCase())
      throw new Error("Connect the vault owner wallet.");
    const on = await readVault(row.vault);
    if (on.owner.toLowerCase() !== wallet.address.toLowerCase())
      throw new Error("Connected wallet does not own this vault.");
    await network();
    return row.vault;
  }
  async function withdraw(protectedExit: boolean) {
    const vault = await verifyOwner();
    if (protectedExit && (!quote || Date.now() >= quote.expiresAt))
      throw new Error("Quote expired. Request a fresh quote.");
    const hash = await wallet.sendTx({
      to: vault,
      data: protectedExit ? quote!.data : encodeExit(),
    });
    setLastTx(hash);
    await wallet.waitReceipt(hash);
    setQuote(null);
    setRow((r) =>
      r
        ? {
            ...r,
            active: false,
            currentPoolId: null,
            valueEth: null,
            reason: "Withdrawal confirmed. Check ETH and token balances in your wallet.",
          }
        : r,
    );
    toast.success("Withdrawal confirmed. Check your wallet balances.");
  }
  async function toggle() {
    if (!wallet.address || !row) return;
    const timestamp = Date.now();
    const active = !row.active;
    const signature = await wallet.signMessage(
      degenAuthMessage(active ? "resume" : "pause", wallet.address, timestamp),
    );
    const r = await setDegenActive({
      data: {
        owner: wallet.address,
        active,
        auth: { timestamp, signature: signature as `0x${string}` },
      },
    });
    setRow(r);
  }
  async function recoverVault() {
    if (!isAddress(recovery) || !wallet.address)
      throw new Error("Enter a vault address and connect its owner wallet.");
    const on = await readVault(recovery);
    if (on.owner.toLowerCase() !== wallet.address.toLowerCase())
      throw new Error("This wallet is not the vault owner.");
    setQuote(null);
    setRow({
      vault: recovery,
      owner: on.owner,
      universe: "all",
      active: false,
      eth: 0,
      currentPoolId: null,
      lastTick: 0,
      enteredAt: 0,
      hops: [],
      reason: "Recovered directly from chain. Owner withdrawals available.",
      valueEth: null,
      valuedAt: 0,
      pendingHash: null,
      halted: true,
    });
  }
  async function rescue(nft: boolean) {
    const vault = await verifyOwner();
    if (!nft && !isAddress(rescueToken)) throw new Error("Enter the token contract address.");
    const data = nft
      ? encodeFunctionData({ abi: DEGEN_ABI, functionName: "rescueNft" })
      : encodeFunctionData({
          abi: DEGEN_ABI,
          functionName: "rescueToken",
          args: [rescueToken as `0x${string}`],
        });
    const hash = await wallet.sendTx({ to: vault, data });
    setLastTx(hash);
    await wallet.waitReceipt(hash);
    toast.success("Recovery transaction confirmed.");
  }
  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl bg-surface p-6 shadow-[var(--shadow-border)] md:p-8">
        <p className="text-xs font-medium tracking-widest text-accent uppercase">
          Degen · controlled beta
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold md:text-4xl">
          Test first. Enter selectively. Keep an exit.
        </h1>
        <p className="mt-3 max-w-3xl text-sm text-muted">
          The keeper considers exit value, costs and risk before changing pools. High APR alone is
          not a reason to trade. Losses remain possible, including when a token cannot be sold.
        </p>
        <p role="status" className="mt-4 rounded-md bg-surface-2 p-3 text-sm">
          {ready.ready
            ? "Live prerequisites available. Reviewed pools and execution checks still apply."
            : ready.reason}
        </p>
      </section>
      <DegenSimulator />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <h2 className="text-xl font-semibold">Your real vault</h2>
          {!wallet.address ? (
            <>
              <p className="my-3 text-sm text-muted">
                Wallet connection is only needed for real vaults. The test lab is free.
              </p>
              <Button onClick={() => void action(() => wallet.connect())} disabled={busy}>
                Connect wallet
              </Button>
            </>
          ) : null}
          {row ? (
            <div className="mt-4 space-y-4">
              <a
                className="block break-all font-mono text-xs text-accent underline"
                target="_blank"
                rel="noreferrer"
                href={explorerAddress(row.vault)}
              >
                {row.vault}
              </a>
              <p className="rounded-md bg-surface-2 p-3 text-sm" role="status">
                {row.reason}
              </p>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-muted">Recorded initial deposit</dt>
                  <dd className="font-mono">{row.eth.toFixed(8)} ETH</dd>
                </div>
                <div>
                  <dt className="text-muted">Conservative exit estimate</dt>
                  <dd className="font-mono">
                    {row.valueEth !== null && now - row.valuedAt < 60000
                      ? `${row.valueEth.toFixed(8)} ETH`
                      : "Unavailable / stale"}
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-muted">
                Exit estimate excludes owner gas and may undercount accrued fees. It is not a
                guaranteed wallet balance.
              </p>
              <Button
                variant="secondary"
                disabled={busy || (!row.active && (!ready.ready || row.halted))}
                onClick={() => void action(toggle)}
              >
                {row.active ? "Pause new trades" : "Resume monitoring"}
              </Button>
              <p className="text-xs text-muted">
                Pausing leaves the position exposed. Withdraw to remove liquidity.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await verifyOwner();
                      setQuote(await prepareExit(row.vault));
                    })
                  }
                >
                  Quote protected ETH exit
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => void action(() => withdraw(false))}
                >
                  Withdraw ETH + raw tokens
                </Button>
              </div>
              <p className="text-xs text-muted">
                Raw withdrawal makes no market sale. You may receive tokens that have lost value or
                cannot be sold. This option also supports older vaults.
              </p>
              {quote ? (
                <div className="rounded-md border border-border p-3 text-sm">
                  <p>
                    Minimum return: {quote.minimumEth.toFixed(8)} ETH before gas. Quote expires in{" "}
                    {Math.max(0, Math.floor((quote.expiresAt - now) / 1000))}s.
                  </p>
                  <Button
                    className="mt-2"
                    disabled={busy || now >= quote.expiresAt}
                    onClick={() => void action(() => withdraw(true))}
                  >
                    Confirm protected withdrawal
                  </Button>
                </div>
              ) : null}
              {row.pendingHash ? (
                <a
                  className="block text-sm text-accent underline"
                  href={explorerTx(row.pendingHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Pending keeper transaction
                </a>
              ) : null}
              <details className="text-sm">
                <summary>Recovery if withdrawal fails</summary>
                <p className="my-2 text-xs text-muted">
                  You can recover the position NFT to manage it yourself, or sweep a token left in
                  the vault. These actions require the owner wallet and network gas.
                </p>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void action(() => rescue(true))}
                >
                  Recover position NFT
                </Button>
                <label className="mt-3 block text-xs">
                  Token contract address
                  <input
                    className="mt-1 block w-full rounded-md bg-surface-2 p-2"
                    value={rescueToken}
                    onChange={(e) => setRescueToken(e.target.value)}
                  />
                </label>
                <Button
                  variant="secondary"
                  className="mt-2"
                  disabled={busy}
                  onClick={() => void action(() => rescue(false))}
                >
                  Recover token balance
                </Button>
              </details>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">
              No registered vault loaded. Recovery remains available even if the first pool entry
              failed.
            </p>
          )}
          {lastTx ? (
            <a
              className="mt-4 block text-sm text-accent underline"
              href={explorerTx(lastTx)}
              target="_blank"
              rel="noreferrer"
            >
              View submitted transaction and confirmation status
            </a>
          ) : null}
          {pending ? (
            <div className="mt-4 rounded-md bg-surface-2 p-3">
              <p className="text-sm">A vault deployment needs confirmation. Do not deploy again.</p>
              <Button
                className="mt-2"
                disabled={busy}
                onClick={() => void action(() => recoverArm(pending))}
              >
                Recover pending deployment
              </Button>
            </div>
          ) : null}
          <details className="mt-5 text-sm">
            <summary>Recover an existing vault by address</summary>
            <label className="mt-2 block text-xs">
              Vault contract address
              <input
                className="mt-1 block w-full rounded-md bg-surface-2 p-2"
                value={recovery}
                onChange={(e) => setRecovery(e.target.value)}
              />
            </label>
            <Button
              className="mt-2"
              variant="secondary"
              disabled={busy}
              onClick={() => void action(recoverVault)}
            >
              Load owner withdrawal controls
            </Button>
          </details>
        </section>
        <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <h2 className="text-xl font-semibold">Create a real vault</h2>
          <p className="mt-2 text-sm text-muted">
            Requires a continuous worker, reviewed tokens and live execution enabled. The free
            five-minute scheduler is a fallback; it cannot provide continuous protection.
          </p>
          <label htmlFor="degen-amount" className="mt-4 block text-xs text-muted">
            Deposit (ETH)
          </label>
          <input
            id="degen-amount"
            type="number"
            min={MIN_ARM_ETH}
            max={MAX_ARM_ETH}
            step="0.00001"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mt-1 w-full rounded-md bg-surface-2 p-3 font-mono"
            disabled={busy || !!row || !!pending}
          />
          <p className="mt-2 text-xs text-muted">
            Keeper contribution: {OPERATOR_STIPEND_ETH} ETH. Total before network gas:{" "}
            {((Number(amount) || 0) + OPERATOR_STIPEND_ETH).toFixed(5)} ETH. Small deposits may
            remain in WETH because expected fees do not cover costs.
          </p>
          <Button
            className="mt-4"
            disabled={busy || !ready.ready || !wallet.address || !!row || !!pending}
            onClick={() => void action(arm)}
          >
            Create vault on-chain
          </Button>
          <p className="mt-3 text-xs text-muted">
            New contracts restrict the keeper to owner-approved tokens, a 30-minute interval and
            four entries per day. The operator can still make losing trades. This beta has not
            received an independent audit.
          </p>
        </section>
      </div>
    </div>
  );
}
