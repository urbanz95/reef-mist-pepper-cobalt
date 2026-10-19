import {
  createPublicClient,
  custom,
  http,
  encodeDeployData,
  parseEther,
  formatEther,
  parseAbi,
  zeroAddress,
  decodeAbiParameters,
} from "viem";
import { CONTRACTS, ROBINHOOD_CHAIN_ID } from "../../src/lib/chain.ts";
import {
  PAPER_PROBE_ABI as PROBE_ABI,
  PAPER_PROBE_BYTECODE as PROBE_BYTECODE,
} from "../../src/lib/degen-paper-probe-artifact.ts";
import { POLICY } from "../../src/lib/degen-policy.ts";
import { createPoolProvider, METADATA_MAX_AGE_MS } from "./provider.mjs";
import { sampleSpotPool } from "./spot-market.mjs";
import { paperVersion, nativeFunding, hashPoolId } from "../../src/lib/paper-venues.ts";
import { LAUNCH_DISCOVERY_PATHS, PONS_DISCOVERY_PATHS } from "./universe.mjs";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const GECKO = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const allowedMethods = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_getLogs",
  "eth_getCode",
]);
export function readOnlyProvider(provider) {
  return {
    request: async (args) => {
      if (!allowedMethods.has(args.method))
        throw new Error(`Paper runner forbids RPC method: ${args.method}`);
      return provider.request(args);
    },
  };
}
const wire = http(RPC, { timeout: 10000, retryCount: 0 })({});
export const client = createPublicClient({
  transport: custom(readOnlyProvider(wire), { retryCount: 0 }),
});
const abi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function getPool(address,address,uint24) view returns (address)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);
const metadata = new Map();
export function normalizePools(json, launch = false) {
  const tokens = new Map(
    (json.included ?? []).filter((t) => t.type === "token").map((t) => [t.id, t.attributes]),
  );
  const data = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];
  return data
    .map((p) => {
      const a = p.attributes ?? {};
      const t0 = tokens.get(p.relationships?.base_token?.data?.id),
        t1 = tokens.get(p.relationships?.quote_token?.data?.id);
      if (!t0 || !t1 || ![t0.address, t1.address].every((t) => /^0x[0-9a-f]{40}$/i.test(t ?? "")))
        return null;
      if (!/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(a.address ?? "")) return null;
      const dex = p.relationships?.dex?.data?.id;
      const isFunding = (t) =>
        t.toLowerCase() === CONTRACTS.weth.toLowerCase() ||
        (launch &&
          nativeFunding(dex) &&
          [zeroAddress, "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"].includes(t.toLowerCase()));
      const isWeth = [t0.address, t1.address].some(isFunding);
      const executionBlock = !(launch ? paperVersion(dex) : dex === "uniswap-v3-robinhood")
        ? `Unsupported DEX: ${dex ?? "unknown"}; observation only`
        : !isWeth
          ? "Unsupported quote token; executor requires canonical WETH"
          : !new RegExp(hashPoolId(dex) ? "^0x[0-9a-f]{64}$" : "^0x[0-9a-f]{40}$", "i").test(
                a.address,
              )
            ? "Unsupported pool identifier"
            : null;
      const tvlUsd = Number(a.reserve_in_usd),
        volume24h = Number(a.volume_usd?.h24),
        parsedCreation = Date.parse(a.pool_created_at ?? ""),
        createdAt = Number.isFinite(parsedCreation) ? parsedCreation : 0;
      if (![tvlUsd, volume24h, createdAt].every(Number.isFinite) || tvlUsd <= 0 || volume24h < 0)
        return null;
      const other = isFunding(t0.address) ? t1.address : t0.address;
      return {
        dex: dex ?? "unknown",
        executionBlock,
        wethUsd: isWeth
          ? Number(isFunding(t0.address) ? a.base_token_price_usd : a.quote_token_price_usd)
          : null,
        other: other.toLowerCase(),
        id: a.address.toLowerCase(),
        label: a.name ?? a.address,
        tvlUsd,
        volume24h,
        createdAt,
      };
    })
    .filter(Boolean);
}
async function feed(path) {
  const started = Date.now();
  const res = await fetch(
    `${path.startsWith("/search/") ? "https://api.geckoterminal.com/api/v2" : GECKO}${path}`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!res.ok) {
    const error = new Error(`Pool provider HTTP ${res.status}`);
    const retry = res.headers.get("retry-after");
    error.retryAfterMs = retry
      ? /^\d+$/.test(retry)
        ? Number(retry) * 1000
        : Math.max(0, Date.parse(retry) - Date.now())
      : 0;
    throw error;
  }
  const age = Number(res.headers.get("age") ?? 0);
  if (!Number.isFinite(age) || age < 0) throw new Error("Invalid provider cache age");
  return {
    pools: normalizePools(
      await res.json(),
      ["launch", "guarded"].includes(process.env.PAPER_STRATEGY),
    ).map((p) => ({
      ...p,
      fetchedAt: started - age * 1000,
    })),
    fetchedAt: started - age * 1000,
    providerAgeSec: age,
  };
}
const provider = createPoolProvider(
  feed,
  Date.now,
  process.env.PAPER_STRATEGY === "guarded"
    ? PONS_DISCOVERY_PATHS
    : process.env.PAPER_STRATEGY === "launch"
      ? LAUNCH_DISCOVERY_PATHS
      : undefined,
);
export const seedProvider = (pools) => provider.seed(pools);
export const discover = () => provider.discover();
export function currentPool(id) {
  if (!/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(id)) throw new Error("Invalid pool identifier");
  return provider.currentPool(id);
}
async function poolMeta(pool) {
  if (metadata.has(pool.id)) return metadata.get(pool.id);
  const [token0, token1, fee] = await Promise.all(
    ["token0", "token1", "fee"].map((functionName) =>
      client.readContract({ address: pool.id, abi, functionName }),
    ),
  );
  const weth = CONTRACTS.weth.toLowerCase();
  if (token0.toLowerCase() !== weth && token1.toLowerCase() !== weth)
    throw new Error("Not an on-chain WETH pair");
  const canonical = await client.readContract({
    address: CONTRACTS.v3Factory,
    abi,
    functionName: "getPool",
    args: [token0, token1, fee],
  });
  if (canonical === zeroAddress || canonical.toLowerCase() !== pool.id)
    throw new Error("Pool factory mismatch");
  const other = token0.toLowerCase() === weth ? token1 : token0;
  const decimals = await client.readContract({ address: other, abi, functionName: "decimals" });
  if (decimals > 36 || ![100, 500, 3000, 10000].includes(fee))
    throw new Error("Unsupported token decimals or pool fee");
  const result = { token0, token1, other, decimals, fee };
  metadata.set(pool.id, result);
  return result;
}
export async function chainSnapshot() {
  if ((await client.getChainId()) !== ROBINHOOD_CHAIN_ID) throw new Error("Wrong chain");
  const block = await client.getBlock();
  const at = Number(block.timestamp) * 1000;
  if (Date.now() - at > POLICY.maxDataAgeMs || at > Date.now() + 15000)
    throw new Error("Chain head is stale");
  return { block: String(block.number), at, gasPrice: await client.getGasPrice() };
}
let quoteBlock = "",
  quoteCache = new Map();
export async function samplePool(pool, capital, fetchedAt, snapshot, paperTokens, launch = false) {
  if (pool.executionBlock) throw new Error(pool.executionBlock);
  if (launch) return sampleSpotPool(client, pool, capital, fetchedAt, snapshot);
  const m = await poolMeta(pool);
  if (m.other.toLowerCase() !== pool.other) throw new Error("Provider token identity mismatch");
  if (quoteBlock !== snapshot.block) {
    quoteBlock = snapshot.block;
    quoteCache.clear();
  }
  if (!quoteCache.has(pool.id))
    quoteCache.set(
      pool.id,
      Promise.all([
        client.readContract({
          address: pool.id,
          abi,
          functionName: "slot0",
          blockNumber: BigInt(snapshot.block),
        }),
        client.readContract({
          address: CONTRACTS.weth,
          abi,
          functionName: "balanceOf",
          args: [pool.id],
          blockNumber: BigInt(snapshot.block),
        }),
        client.readContract({
          address: m.other,
          abi,
          functionName: "balanceOf",
          args: [pool.id],
          blockNumber: BigInt(snapshot.block),
        }),
      ]),
    );
  const [slot, wethBalance, otherBalance] = await quoteCache.get(pool.id);
  const ratio = (Number(slot[0]) / 2 ** 96) ** 2;
  const priceEth =
    m.token0.toLowerCase() === CONTRACTS.weth.toLowerCase()
      ? 10 ** (m.decimals - 18) / ratio
      : ratio * 10 ** (m.decimals - 18);
  if (!Number.isFinite(priceEth) || priceEth <= 0) throw new Error("Invalid on-chain price");
  if (!Number.isFinite(pool.wethUsd) || pool.wethUsd <= 0)
    throw new Error("ETH/USD metadata reference unavailable");
  const reserveEth =
    Number(formatEther(wethBalance)) + (Number(otherBalance) / 10 ** m.decimals) * priceEth;
  const tvlUsd = reserveEth * pool.wethUsd;
  if (!Number.isFinite(reserveEth) || reserveEth <= 0 || !Number.isFinite(tvlUsd) || tvlUsd <= 0)
    throw new Error("Invalid on-chain pool reserves");
  const metadataAge = Date.now() - fetchedAt;
  const metadataFresh = metadataAge >= 0 && metadataAge <= METADATA_MAX_AGE_MS;
  const amount = parseEther(capital.toFixed(18));
  const spacing = { 100: 1, 500: 10, 3000: 60, 10000: 200 }[m.fee],
    upper = Math.floor(887272 / spacing) * spacing;
  const data = encodeDeployData({
    abi: PROBE_ABI,
    bytecode: PROBE_BYTECODE,
    args: [CONTRACTS.weth, CONTRACTS.npm, CONTRACTS.swapRouter02, m.other, m.fee, -upper, upper],
  });
  const account = "0x000000000000000000000000000000000000bEEF";
  const request = {
    account,
    data,
    value: amount + parseEther(".00005"),
    gas: 12000000n,
    stateOverride: [{ address: account, balance: parseEther("100") }],
    blockNumber: BigInt(snapshot.block),
  };
  const result = await client.call(request);
  if (!result.data || result.data.length !== 194)
    throw new Error("Round-trip probe returned no value");
  const [recovered, enterGas, exitGas] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    result.data,
  );
  if (recovered < (amount * 97n) / 100n) throw new Error("Round trip lost over 3%");
  // Add intrinsic/cold-access allowance and a 50% execution margin.
  const entryBudget = Number(formatEther(((enterGas + 51000n) * snapshot.gasPrice * 15n) / 10n));
  const exitBudget = Number(formatEther(((exitGas + 51000n) * snapshot.gasPrice * 15n) / 10n));
  const gasEth = entryBudget + exitBudget;
  const loss = Number(formatEther(amount > recovered ? amount - recovered : 0n));
  return {
    id: pool.id,
    label: pool.label,
    apr: ((((pool.volume24h * m.fee) / 1e6) * 365) / tvlUsd) * 100,
    tvlUsd,
    reserveEth,
    metadataAt: fetchedAt,
    metadataAgeSec: metadataAge / 1000,
    metadataFresh,
    createdAt: pool.createdAt,
    priceEth,
    fetchedAt: snapshot.at,
    factoryVerified: true,
    roundTripOk: true,
    // Experimental paper universe only. Never imported by the real keeper.
    reviewed: metadataFresh && paperTokens.includes(m.other.toLowerCase()),
    costEth: loss + gasEth,
    entryCostEth: loss + entryBudget,
    exitCostEth: exitBudget,
    token: m.other,
    fee: m.fee,
    probeRecoveredEth: formatEther(recovered),
    probeEnterGas: String(enterGas),
    probeExitGas: String(exitGas),
    block: snapshot.block,
    gasBudgetEth: gasEth,
    roundTripLossEth: loss,
    manualReviewVerified: false,
  };
}
