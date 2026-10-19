import { parseAbi } from "viem";
import { BURN_ADDRESSES, assessTokenSecurity } from "../../src/lib/paper-risk.ts";
const abi = parseAbi([
  "function totalSupply() view returns(uint256)",
  "function balanceOf(address) view returns(uint256)",
]);
export function createSecurityProvider(fetcher = fetch, now = Date.now) {
  const cache = new Map();
  let nextRequest = 0,
    backoff = 30000,
    lastError = null;
  return {
    get(token) {
      return cache.get(token.toLowerCase());
    },
    get lastError() {
      return lastError;
    },
    async refresh(tokens) {
      const needed = [...new Set(tokens.map((t) => t.toLowerCase()))]
        .filter((t) => !cache.has(t) || now() - cache.get(t).checkedAt >= 30000)
        .slice(0, 10);
      if (!needed.length || now() < nextRequest) return;
      nextRequest = now() + 30000;
      try {
        const res = await fetcher(
          `https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=${needed.join(",")}`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) {
          const e = new Error(`Security provider HTTP ${res.status}`);
          const retry = res.headers.get("retry-after");
          e.retry =
            retry === null
              ? 0
              : /^\d+(\.\d+)?$/.test(retry)
                ? Number(retry) * 1000
                : Math.max(0, Date.parse(retry) - now());
          throw e;
        }
        const age = Number(res.headers.get("age") ?? 0);
        if (!Number.isFinite(age) || age < 0) throw new Error("Invalid security cache age");
        const data = await res.json();
        if (
          data.code !== 1 ||
          !data.result ||
          typeof data.result !== "object" ||
          Array.isArray(data.result)
        )
          throw new Error("Security provider returned no supported result");
        const rows = new Map(Object.entries(data.result).map(([a, v]) => [a.toLowerCase(), v]));
        for (const t of needed) cache.set(t, { raw: rows.get(t), checkedAt: now() - age * 1000 });
        lastError = null;
        backoff = 30000;
      } catch (e) {
        lastError = e.message;
        nextRequest = now() + Math.max(backoff, Number.isFinite(e.retry) ? e.retry : 0);
        backoff = Math.min(900000, backoff * 2);
      }
    },
  };
}
export async function liquidityProtection(client, pool, block) {
  if (pool.dex !== "uniswap-v2-robinhood")
    return {
      status: "unknown",
      reason:
        "Pool-specific V3/V4 position ownership and withdrawal permissions not fully verified",
    };
  try {
    const call = (functionName, args = []) =>
      client.readContract({
        address: pool.id,
        abi,
        functionName,
        args,
        blockNumber: BigInt(block),
      });
    const [supply, ...burned] = await Promise.all([
      call("totalSupply"),
      ...BURN_ADDRESSES.map((a) => call("balanceOf", [a])),
    ]);
    if (supply <= 0n) return { status: "unknown", reason: "LP supply unavailable" };
    const amount = burned.reduce((a, b) => a + b, 0n);
    if (amount > supply) return { status: "unknown", reason: "Invalid LP burn accounting" };
    const fraction = Number(amount) / Number(supply);
    const protectedLp = amount * 100n >= supply * 95n;
    return {
      status: protectedLp ? "approved" : "rejected",
      fraction,
      reason: protectedLp
        ? "At least 95% of canonical V2 LP supply is at burn addresses"
        : "Less than 95% of canonical V2 LP supply is provably burned; locker contracts require a verified adapter",
    };
  } catch {
    return { status: "unknown", reason: "LP ownership proof unavailable" };
  }
}
export async function assessPoolSecurity(client, pool, snapshot, provider, now = Date.now()) {
  const row = provider.get(pool.other),
    lp = await liquidityProtection(client, pool, snapshot.block);
  return {
    ...assessTokenSecurity(row?.raw, pool, row?.checkedAt ?? 0, now, lp),
    liquidityBlock: snapshot.block,
  };
}
