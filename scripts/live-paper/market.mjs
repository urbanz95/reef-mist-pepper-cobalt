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
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const GECKO = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const allowedMethods = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
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
const client = createPublicClient({ transport: custom(readOnlyProvider(wire), { retryCount: 0 }) });
const abi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function getPool(address,address,uint24) view returns (address)",
  "function decimals() view returns (uint8)",
]);
const metadata = new Map();
export function normalizePools(json) {
  const tokens = new Map(
    (json.included ?? []).filter((t) => t.type === "token").map((t) => [t.id, t.attributes]),
  );
  const data = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];
  return data
    .map((p) => {
      const a = p.attributes ?? {};
      const t0 = tokens.get(p.relationships?.base_token?.data?.id),
        t1 = tokens.get(p.relationships?.quote_token?.data?.id);
      if (
        !t0 ||
        !t1 ||
        ![t0.address, t1.address].some((t) => t?.toLowerCase() === CONTRACTS.weth.toLowerCase())
      )
        return null;
      if (!/^0x[0-9a-f]{40}$/i.test(a.address ?? "")) return null;
      const tvlUsd = Number(a.reserve_in_usd),
        volume24h = Number(a.volume_usd?.h24),
        createdAt = Date.parse(a.pool_created_at ?? "");
      if (![tvlUsd, volume24h, createdAt].every(Number.isFinite) || tvlUsd <= 0 || volume24h < 0)
        return null;
      const other =
        t0.address.toLowerCase() === CONTRACTS.weth.toLowerCase() ? t1.address : t0.address;
      return {
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
  const res = await fetch(`${GECKO}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Pool provider HTTP ${res.status}`);
  const age = Number(res.headers.get("age") ?? 0);
  if (!Number.isFinite(age) || age < 0) throw new Error("Invalid provider cache age");
  return {
    pools: normalizePools(await res.json()),
    fetchedAt: started - age * 1000,
    providerAgeSec: age,
  };
}
export async function discover() {
  return feed("/dexes/uniswap-v3-robinhood/pools?page=1&include=base_token,quote_token");
}
export async function currentPool(id) {
  if (!/^0x[0-9a-f]{40}$/i.test(id)) throw new Error("Invalid pool address");
  return feed(`/pools/${id}?include=base_token,quote_token`);
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
export async function samplePool(pool, capital, fetchedAt, snapshot, paperTokens) {
  const m = await poolMeta(pool);
  if (m.other.toLowerCase() !== pool.other) throw new Error("Provider token identity mismatch");
  const slot = await client.readContract({
    address: pool.id,
    abi,
    functionName: "slot0",
    blockNumber: BigInt(snapshot.block),
  });
  const ratio = (Number(slot[0]) / 2 ** 96) ** 2;
  const priceEth =
    m.token0.toLowerCase() === CONTRACTS.weth.toLowerCase()
      ? 10 ** (m.decimals - 18) / ratio
      : ratio * 10 ** (m.decimals - 18);
  if (!Number.isFinite(priceEth) || priceEth <= 0) throw new Error("Invalid on-chain price");
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
    apr: ((((pool.volume24h * m.fee) / 1e6) * 365) / pool.tvlUsd) * 100,
    tvlUsd: pool.tvlUsd,
    createdAt: pool.createdAt,
    priceEth,
    fetchedAt: Math.min(fetchedAt, snapshot.at),
    factoryVerified: true,
    roundTripOk: true,
    // Experimental paper universe only. Never imported by the real keeper.
    reviewed: paperTokens.includes(m.other.toLowerCase()),
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
