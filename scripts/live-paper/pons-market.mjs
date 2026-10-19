import { parseAbi, zeroAddress, keccak256 } from "viem";
import { CONTRACTS } from "../../src/lib/chain.ts";
import { PONS_STACKS, PONS_LOCKER_HASH } from "../../src/lib/pons-contracts.ts";
import { poolKeyHash } from "./pool-key.mjs";
export const ponsAbi = parseAbi([
  "function factory() view returns(address)",
  "function token() view returns(address)",
  "function pairToken() view returns(address)",
  "function locker() view returns(address)",
  "function positionManager() view returns(address)",
  "function memeHook() view returns(address)",
  "function graduated() view returns(bool)",
  "function readyToGraduate() view returns(bool)",
  "function decimals() view returns(uint8)",
  "function getLaunchedToken(address) view returns((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function poolKeys(bytes25) view returns(address,address,uint24,int24,address)",
  "function isLocked(address) view returns(bool)",
  "function lockedPositions(address) view returns(uint256)",
  "function ownerOf(uint256) view returns(address)",
  "function getApproved(uint256) view returns(address)",
  "function getPoolAndPositionInfo(uint256) view returns((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint256)",
  "function getPositionLiquidity(uint256) view returns(uint128)",
  "function getLiquidity(bytes32) view returns(uint128)",
]);
const same = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const clientCaches = new WeakMap();
function caches(client) {
  let value = clientCaches.get(client);
  if (!value) {
    value = { code: new Map(), meta: new Map() };
    clientCaches.set(client, value);
  }
  return value;
}
export function ponsRead(client, snapshot) {
  return (address, functionName, args = []) =>
    client.readContract({
      address: address.toLowerCase(),
      abi: ponsAbi,
      functionName,
      args,
      blockNumber: BigInt(snapshot.block),
    });
}
async function verifyCode(client, address, hash, block) {
  const codeCache = caches(client).code;
  const id = address + ":" + block;
  if (codeCache.size > 256) codeCache.clear();
  if (!codeCache.has(id))
    codeCache.set(id, client.getBytecode({ address, blockNumber: BigInt(block) }));
  const code = await codeCache.get(id);
  if (!code || keccak256(code) !== hash)
    throw new Error("Pons deployed code differs from pinned deployment");
}
/** Registration, protocol generation and graduation are verified at EVERY block.
 * Provider labels cannot promote a curve to a pool or select an arbitrary hook. */
export async function resolvePonsMeta(client, pool, snapshot) {
  const metaCache = caches(client).meta;
  const cacheId = [pool.dex, pool.id, pool.other, snapshot.block].join(":");
  if (metaCache.has(cacheId)) return metaCache.get(cacheId);
  const read = ponsRead(client, snapshot);
  let stack, key;
  if (pool.dex === "pons-v2") {
    if (!/^0x[0-9a-f]{40}$/i.test(pool.id)) throw new Error("Invalid Pons curve identifier");
    const factory = await read(pool.id, "factory");
    stack = PONS_STACKS.find((s) => same(s.factory, factory));
  } else if (pool.dex === "pons-v2-dex") {
    if (!/^0x[0-9a-f]{64}$/i.test(pool.id)) throw new Error("Invalid Pons V4 pool identifier");
    const k = await read(CONTRACTS.v4PositionManager, "poolKeys", [pool.id.slice(0, 52)]);
    key = { currency0: k[0], currency1: k[1], fee: k[2], tickSpacing: k[3], hooks: k[4] };
    if (!key.tickSpacing || poolKeyHash(key) !== pool.id)
      throw new Error("Pons V4 key hash mismatch");
    stack = PONS_STACKS.find((s) => same(s.hook, key.hooks));
  } else throw new Error("Not a Pons venue");
  if (!stack) throw new Error("Unrecognized Pons factory/hook generation");
  await Promise.all([
    verifyCode(client, stack.factory, stack.factoryHash, snapshot.block),
    verifyCode(client, stack.hook, stack.hookHash, snapshot.block),
  ]);
  const [record, pm, hook, locker] = await Promise.all([
    read(stack.factory, "getLaunchedToken", [pool.other]),
    read(stack.factory, "positionManager"),
    read(stack.factory, "memeHook"),
    read(stack.factory, "locker"),
  ]);
  if (
    !record.exists ||
    !same(record.token, pool.other) ||
    !same(pm, CONTRACTS.v4PositionManager) ||
    !same(hook, stack.hook) ||
    !same(locker, stack.locker)
  )
    throw new Error("Pons factory registration mismatch");
  if (!same(record.pairToken, zeroAddress) && !same(record.pairToken, CONTRACTS.weth))
    throw new Error("Unsupported Pons quote asset");
  const [token, factory, pair, graduated, ready, decimals] = await Promise.all([
    read(record.curve, "token"),
    read(record.curve, "factory"),
    read(record.curve, "pairToken"),
    read(record.curve, "graduated"),
    read(record.curve, "readyToGraduate"),
    read(record.token, "decimals"),
  ]);
  if (
    !same(token, record.token) ||
    !same(factory, stack.factory) ||
    !same(pair, record.pairToken) ||
    (pool.dex === "pons-v2" && !same(pool.id, record.curve))
  )
    throw new Error("Pons curve/token identity mismatch");
  if (decimals > 36) throw new Error("Unsupported Pons token decimals");
  if (record.phase === 1)
    throw new Error("Pons graduation in progress: curve closed, pool not seeded");
  if (record.phase === 3) throw new Error("Pons launch rescued: normal trading route unavailable");
  if (record.phase !== 0 && record.phase !== 2) throw new Error("Unknown Pons graduation phase");
  if (record.phase === 0 && (graduated || ready))
    throw new Error("Pons curve sell side closed awaiting graduation");
  if (record.phase === 2 && !graduated) throw new Error("Pons graduation state inconsistent");
  const sorted = [record.token, record.pairToken].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );
  const expectedKey = {
    currency0: sorted[0],
    currency1: sorted[1],
    fee: record.poolFee,
    tickSpacing: record.tickSpacing,
    hooks: stack.hook,
  };
  if (pool.dex === "pons-v2-dex" && (record.phase !== 2 || poolKeyHash(expectedKey) !== pool.id))
    throw new Error("Pons V4 registration does not match graduated pool");
  const version = record.phase === 2 ? 4 : 5;
  key =
    version === 4
      ? expectedKey
      : {
          currency0: record.pairToken,
          currency1: record.token,
          fee: 0,
          tickSpacing: 0,
          hooks: zeroAddress,
        };
  const value = {
    version,
    key,
    other: record.token,
    decimals,
    funding0: same(key.currency0, record.pairToken),
    curve: record.curve,
    stack,
    record,
    stage: version === 4 ? "graduated" : "curve",
    executionId: version === 4 ? poolKeyHash(key) : record.curve,
    executor: version === 4 ? CONTRACTS.v4PoolManager : record.curve,
    evidence: {
      status: "pons_factory_registration_verified",
      migrationStatus: "unconfirmed",
      blockNumber: snapshot.block,
      emitter: stack.factory,
    },
  };
  if (metaCache.size > 128) metaCache.clear();
  metaCache.set(cacheId, value);
  return value;
}
/** The reviewed locker has no outbound NFT/approval path. Its sole CALL is an
 * inbound transferFrom, and setFactory is one-shot. Unknown runtimes fail closed. */
export async function ponsLiquidityProtection(client, pool, snapshot) {
  const m = await resolvePonsMeta(client, pool, snapshot);
  if (m.version === 5)
    return {
      status: "unknown",
      reason: "Pre-graduation curve: no permanently locked LP position; entry requires graduation",
    };
  if (m.stack.lockerHash !== PONS_LOCKER_HASH)
    return {
      status: "unknown",
      reason: "Earlier Pons locker runtime has not been reviewed for withdrawal permissions",
    };
  await verifyCode(client, m.stack.locker, PONS_LOCKER_HASH, snapshot.block);
  const read = ponsRead(client, snapshot),
    locker = m.stack.locker;
  const [factory, manager, locked, id] = await Promise.all([
    read(locker, "factory"),
    read(locker, "positionManager"),
    read(locker, "isLocked", [m.other]),
    read(locker, "lockedPositions", [m.other]),
  ]);
  if (
    !same(factory, m.stack.factory) ||
    !same(manager, CONTRACTS.v4PositionManager) ||
    !locked ||
    id === 0n
  )
    return {
      status: "rejected",
      reason: "Pons permanent seed position not registered in the pinned locker",
    };
  const [owner, approved, position, liquidity, total] = await Promise.all([
    read(manager, "ownerOf", [id]),
    read(manager, "getApproved", [id]),
    read(manager, "getPoolAndPositionInfo", [id]),
    read(manager, "getPositionLiquidity", [id]),
    read(CONTRACTS.v4StateView, "getLiquidity", [m.executionId]),
  ]);
  const info = position[1],
    signed24 = (n) => Number(n >= 8388608n ? n - 16777216n : n),
    lower = signed24((info >> 8n) & 16777215n),
    upper = signed24((info >> 32n) & 16777215n),
    bound = Math.floor(887272 / m.key.tickSpacing) * m.key.tickSpacing;
  if (
    !same(owner, locker) ||
    !same(approved, zeroAddress) ||
    poolKeyHash(position[0]) !== m.executionId ||
    lower !== -bound ||
    upper !== bound ||
    liquidity <= 0n ||
    total <= 0n ||
    liquidity > total
  )
    return {
      status: "rejected",
      reason: "Pons seed ownership, approval, range or liquidity mismatch",
    };
  const protectedLp = liquidity * 100n >= total * 95n;
  return {
    status: protectedLp ? "approved" : "rejected",
    fraction: Number(liquidity) / Number(total),
    reason: protectedLp
      ? "Pinned permanent Pons seed position covers at least 95% of active pool liquidity"
      : "Locked Pons seed covers less than 95% of active liquidity",
    evidence: {
      locker,
      positionId: String(id),
      lockedLiquidity: String(liquidity),
      activeLiquidity: String(total),
      block: snapshot.block,
      withdrawalRuntimeHash: PONS_LOCKER_HASH,
    },
  };
}
