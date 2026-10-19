import {
  parseAbi,
  encodeAbiParameters,
  keccak256,
  encodeDeployData,
  parseEther,
  formatEther,
  decodeAbiParameters,
  zeroAddress,
  getContractAddress,
  encodeFunctionData,
  decodeFunctionResult,
  toHex,
} from "viem";
import { CONTRACTS } from "../../src/lib/chain.ts";
import {
  SPOT_PROBE_ABI,
  SPOT_PROBE_BYTECODE,
  SPOT_EXIT_ABI,
  SPOT_EXIT_BYTECODE,
} from "../../src/lib/spot-paper-probe-artifact.ts";
import { METADATA_MAX_AGE_MS } from "./provider.mjs";
import { poolCreationEvidence } from "./pool-evidence.mjs";
const abi = parseAbi([
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function getPair(address,address) view returns(address)",
  "function getPool(address,address,uint24) view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function decimals() view returns(uint8)",
  "function fee() view returns(uint24)",
  "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)",
  "function getLiquidity(bytes32) view returns(uint128)",
  "function poolKeys(bytes25) view returns(address,address,uint24,int24,address)",
]);
const keys = new Map();
import { poolKeyHash } from "./pool-key.mjs";
export { poolKeyHash } from "./pool-key.mjs";
import { isPons, paperVersion } from "../../src/lib/paper-venues.ts";
import { resolvePonsMeta } from "./pons-market.mjs";
export async function resolveSpotMeta(client, pool, snapshot) {
  if (isPons(pool.dex)) return resolvePonsMeta(client, pool, snapshot);
  const read = (address, functionName, args = []) =>
    client.readContract({
      address: address.toLowerCase(),
      abi,
      functionName,
      args,
      blockNumber: BigInt(snapshot.block),
    });
  let m = keys.get(pool.id);
  if (!m) {
    const version =
      pool.dex === "uniswap-v2-robinhood"
        ? 2
        : pool.dex === "uniswap-v3-robinhood"
          ? 3
          : pool.dex === "uniswap-v4-robinhood"
            ? 4
            : 0;
    if (!version) throw new Error("Unsupported spot DEX");
    let key, evidence;
    if (version === 4) {
      const k = await read(CONTRACTS.v4PositionManager, "poolKeys", [pool.id.slice(0, 52)]);
      key = { currency0: k[0], currency1: k[1], fee: k[2], tickSpacing: k[3], hooks: k[4] };
      if (!key.tickSpacing || poolKeyHash(key).toLowerCase() !== pool.id.toLowerCase()) {
        evidence = await poolCreationEvidence(client, pool.id, 4, key, snapshot);
        key = evidence.key;
        if (!key || poolKeyHash(key).toLowerCase() !== pool.id.toLowerCase())
          throw new Error("V4 key unavailable or hash mismatch");
      }
    } else {
      const [currency0, currency1] = await Promise.all([
        read(pool.id, "token0"),
        read(pool.id, "token1"),
      ]);
      const fee = version === 3 ? await read(pool.id, "fee") : 3000;
      key = { currency0, currency1, fee, tickSpacing: 0, hooks: zeroAddress };
      const canonical =
        version === 2
          ? await read(CONTRACTS.v2Factory, "getPair", [currency0, currency1])
          : await read(CONTRACTS.v3Factory, "getPool", [currency0, currency1, fee]);
      if (canonical.toLowerCase() !== pool.id || canonical === zeroAddress)
        throw new Error("Spot pool factory mismatch");
    }
    const isFunding = (c) =>
      c.toLowerCase() === CONTRACTS.weth.toLowerCase() || (version === 4 && c === zeroAddress);
    if (!isFunding(key.currency0) && !isFunding(key.currency1))
      throw new Error("Unsupported funding currency");
    const other = (isFunding(key.currency0) ? key.currency1 : key.currency0).toLowerCase();
    if (other.toLowerCase() !== pool.other) throw new Error("Provider token identity mismatch");
    const decimals = await read(other, "decimals");
    if (decimals > 36) throw new Error("Unsupported token decimals");
    evidence ??= await poolCreationEvidence(client, pool.id, version, key, snapshot);
    m = { version, key, other, decimals, funding0: isFunding(key.currency0), evidence };
    keys.set(pool.id, m);
  }
  if (m.other.toLowerCase() !== pool.other.toLowerCase() || m.version !== paperVersion(pool.dex))
    throw new Error("Cached pool token/protocol identity mismatch");
  return m;
}
export async function spotDepth(client, pool, snapshot) {
  const m = await resolveSpotMeta(client, pool, snapshot);
  const read = (address, functionName, args = []) =>
    client.readContract({
      address: address.toLowerCase(),
      abi,
      functionName,
      args,
      blockNumber: BigInt(snapshot.block),
    });
  let priceEth, reserveEth;
  if (m.version === 5) {
    const [reserves, real] = await Promise.all([
      client.readContract({
        address: m.curve,
        abi: parseAbi(["function getReserves() view returns(uint256,uint256)"]),
        functionName: "getReserves",
        blockNumber: BigInt(snapshot.block),
      }),
      client.readContract({
        address: m.curve,
        abi: parseAbi(["function realQuoteReserve() view returns(uint256)"]),
        functionName: "realQuoteReserve",
        blockNumber: BigInt(snapshot.block),
      }),
    ]);
    priceEth = Number(reserves[0]) / 1e18 / (Number(reserves[1]) / 10 ** m.decimals);
    reserveEth = (2 * Number(real)) / 1e18;
  } else if (m.version === 2) {
    const [r0, r1] = await read(pool.id, "getReserves");
    const funding = Number(m.funding0 ? r0 : r1) / 1e18,
      other = Number(m.funding0 ? r1 : r0) / 10 ** m.decimals;
    priceEth = funding / other;
    reserveEth = 2 * funding;
  } else {
    const slot =
      m.version === 4
        ? await read(CONTRACTS.v4StateView, "getSlot0", [m.executionId ?? pool.id])
        : await read(pool.id, "slot0");
    const ratio = (Number(slot[0]) / 2 ** 96) ** 2;
    priceEth = (m.funding0 ? 1 / ratio : ratio) * 10 ** (m.decimals - 18);
    if (m.version === 4) {
      const liquidity = await read(CONTRACTS.v4StateView, "getLiquidity", [
        m.executionId ?? pool.id,
      ]);
      // Active virtual depth, not the shared manager balance or actual per-pool TVL.
      const fundingRaw = m.funding0
        ? Number(liquidity) / (Number(slot[0]) / 2 ** 96)
        : Number(liquidity) * (Number(slot[0]) / 2 ** 96);
      reserveEth = (2 * fundingRaw) / 1e18;
    } else {
      const balancesAbi = parseAbi(["function balanceOf(address) view returns(uint256)"]);
      const funding = await client.readContract({
        address: CONTRACTS.weth,
        abi: balancesAbi,
        functionName: "balanceOf",
        args: [pool.id],
        blockNumber: BigInt(snapshot.block),
      });
      reserveEth = (2 * Number(funding)) / 1e18;
    }
  }
  if (![priceEth, reserveEth, pool.wethUsd].every((x) => Number.isFinite(x) && x > 0))
    throw new Error("Invalid spot price/depth/reference");
  return { m, priceEth, reserveEth };
}
const executorFor = (m) =>
  m.executor ??
  (m.version === 2
    ? CONTRACTS.v2Router
    : m.version === 3
      ? CONTRACTS.swapRouter02
      : CONTRACTS.v4PoolManager);
export const PROBE_ACCOUNT = "0x000000000000000000000000000000000000bEEF";
export const EXIT_WRAPPER = getContractAddress({ from: PROBE_ACCOUNT, nonce: 0n });
export const EXIT_WALLET = getContractAddress({ from: EXIT_WRAPPER, nonce: 1n });
const balances = parseAbi(["function balanceOf(address) view returns(uint256)"]);
const balanceSlots = new Map();
const balanceKey = (slot) =>
  keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [EXIT_WALLET, BigInt(slot)]),
  );
/** Locate a plain ERC20 mapping using read-only overrides. Custom accounting fails closed. */
export async function heldBalanceOverride(client, token, quantity, block) {
  const code = await client.getBytecode({ address: token, blockNumber: BigInt(block) });
  if (!code || code === "0x") throw new Error("Token code unavailable for held balance proof");
  const cacheKey = `${token.toLowerCase()}:${keccak256(code)}`;
  let slot = balanceSlots.get(cacheKey);
  const data = encodeFunctionData({
    abi: balances,
    functionName: "balanceOf",
    args: [EXIT_WALLET],
  });
  const sentinel = 9876543210123456789n;
  const matches = async (index) => {
    try {
      const result = await client.call({
        to: token,
        data,
        blockNumber: BigInt(block),
        stateOverride: [
          {
            address: token,
            stateDiff: [{ slot: balanceKey(index), value: toHex(sentinel, { size: 32 }) }],
          },
        ],
      });
      return (
        decodeFunctionResult({ abi: balances, functionName: "balanceOf", data: result.data }) ===
        sentinel
      );
    } catch {
      return false;
    }
  };
  if (slot === undefined) {
    for (let start = 0; start < 64 && slot === undefined; start += 8) {
      const checks = await Promise.all(Array.from({ length: 8 }, (_, i) => matches(start + i)));
      const match = checks.indexOf(true);
      if (match >= 0) slot = start + match;
    }
    if (slot === undefined)
      throw new Error("Exact held token balance cannot be proved with bounded storage overrides");
    balanceSlots.set(cacheKey, slot);
  }
  // Verify the actual quantity too; never rely solely on a cached sentinel.
  const override = {
    address: token,
    stateDiff: [{ slot: balanceKey(slot), value: toHex(BigInt(quantity), { size: 32 }) }],
  };
  const check = await client.call({
    to: token,
    data,
    blockNumber: BigInt(block),
    stateOverride: [override],
  });
  if (
    decodeFunctionResult({ abi: balances, functionName: "balanceOf", data: check.data }) !==
    BigInt(quantity)
  )
    throw new Error("Held balance override no longer matches");
  return override;
}
export async function quoteHeldExit(client, pool, quantityRaw, snapshot) {
  if (!/^\d+$/.test(quantityRaw) || BigInt(quantityRaw) <= 0n)
    throw new Error("Invalid held quantity");
  const m = await resolveSpotMeta(client, pool, snapshot);
  const override = await heldBalanceOverride(client, m.other, quantityRaw, snapshot.block);
  const data = encodeDeployData({
    abi: SPOT_EXIT_ABI,
    bytecode: SPOT_EXIT_BYTECODE,
    args: [CONTRACTS.weth, m.other, executorFor(m), m.version, m.key, BigInt(quantityRaw)],
  });
  const result = await client.call({
    account: PROBE_ACCOUNT,
    data,
    gas: 12000000n,
    blockNumber: BigInt(snapshot.block),
    stateOverride: [{ address: PROBE_ACCOUNT, balance: parseEther("100"), nonce: 0 }, override],
  });
  if (!result.data || result.data.length !== 130)
    throw new Error("Exact-quantity exit returned no proceeds");
  const [received, gas] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    result.data,
  );
  return {
    pool: pool.id,
    quantityRaw,
    receivedEth: Number(formatEther(received)),
    gasEth: Number(formatEther(((gas + 51000n) * snapshot.gasPrice * 15n) / 10n)),
    fetchedAt: snapshot.at,
    block: snapshot.block,
  };
}
export async function sampleSpotPool(
  client,
  pool,
  capital,
  fetchedAt,
  snapshot,
  { diagnosticOnly = false } = {},
) {
  const { m, priceEth, reserveEth } = await spotDepth(client, pool, snapshot);
  const executor = executorFor(m);
  const amount = parseEther(capital.toFixed(18));
  const data = encodeDeployData({
    abi: SPOT_PROBE_ABI,
    bytecode: SPOT_PROBE_BYTECODE,
    args: [CONTRACTS.weth, m.other, executor, m.version, m.key],
  });
  const account = PROBE_ACCOUNT;
  const result = await client.call({
    account,
    data,
    value: amount,
    gas: 12000000n,
    stateOverride: [{ address: account, nonce: 0, balance: parseEther("100") }],
    blockNumber: BigInt(snapshot.block),
  });
  if (!result.data || result.data.length !== 258) throw new Error("Spot probe returned no value");
  const [recovered, bought, enterGas, exitGas] = decodeAbiParameters(
    Array.from({ length: 4 }, () => ({ type: "uint256" })),
    result.data,
  );
  const roundTripOk = bought > 0n && recovered >= (amount * 97n) / 100n;
  if (bought === 0n || recovered === 0n || (!diagnosticOnly && !roundTripOk))
    throw new Error("Spot round trip lost over 3% or returned no tokens");
  const entryGas = Number(formatEther(((enterGas + 51000n) * snapshot.gasPrice * 15n) / 10n));
  const exitCostEth = Number(formatEther(((exitGas + 51000n) * snapshot.gasPrice * 15n) / 10n));
  const loss = Number(formatEther(amount > recovered ? amount - recovered : 0n));
  const age = Date.now() - fetchedAt,
    metadataFresh = age >= 0 && age <= METADATA_MAX_AGE_MS;
  return {
    id: pool.id,
    label: pool.label,
    token: m.other,
    protocol: m.stage ? `pons-${m.stage}` : `v${m.version}`,
    stage: m.stage,
    executionPool: m.executionId ?? pool.id,
    factory: m.stack?.factory,
    apr: 0,
    tvlUsd: m.version === 4 ? pool.tvlUsd : reserveEth * pool.wethUsd,
    reserveEth,
    createdAt: pool.createdAt,
    priceEth,
    fetchedAt: snapshot.at,
    metadataAt: fetchedAt,
    metadataFresh,
    factoryVerified: true,
    roundTripOk,
    reviewed: metadataFresh,
    costEth: loss + entryGas + exitCostEth,
    entryCostEth: loss + entryGas,
    exitCostEth,
    probeRecoveredEth: formatEther(recovered),
    executionRecovery: Number(recovered) / Number(amount),
    probeBoughtRaw: String(bought),
    quantityRaw: String(bought),
    buyInputEth: Number(formatEther(amount)),
    buyGasEth: entryGas,
    probeEnterGas: String(enterGas),
    probeExitGas: String(exitGas),
    block: snapshot.block,
    migrationStatus: m.stage === "graduated" ? "confirmed" : "unconfirmed",
    poolIdentityVerified: true,
    creationEvidence: m.evidence,
    depthBasis:
      m.version === 5
        ? "real curve quote reserves; phantom excluded"
        : m.version === 4
          ? "active virtual liquidity"
          : "funding reserves",
    manualReviewVerified: false,
  };
}
