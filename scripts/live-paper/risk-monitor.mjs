import { parseAbi, decodeEventLog } from "viem";
import { CONTRACTS } from "../../src/lib/chain.ts";
const events = parseAbi([
  "event Burn(address indexed sender,uint256 amount0,uint256 amount1,address indexed to)",
  "event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
  "event Sync(uint112 reserve0,uint112 reserve1)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)",
  "event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)",
]);
const zero = "0x" + "00".repeat(20);
export function riskFromLog(log, position, previousFunding) {
  let decoded;
  if (position.factory && log.address.toLowerCase() === position.factory.toLowerCase())
    return {
      alert: {
        pool: position.pool,
        token: position.token,
        reason: "Pons factory launch state changed; route recheck required",
        block: String(BigInt(log.blockNumber)),
        transactionHash: log.transactionHash,
      },
    };
  try {
    decoded = decodeEventLog({ abi: events, data: log.data, topics: log.topics });
  } catch {
    return {};
  }
  const { eventName, args } = decoded;
  let reason,
    nextFunding = previousFunding;
  if (log.address.toLowerCase() === position.token.toLowerCase()) {
    if (eventName === "Transfer" && args.from.toLowerCase() === zero)
      reason = "Token supply minted while held";
    if (eventName === "OwnershipTransferred") reason = "Token ownership changed while held";
  } else {
    if (eventName === "Burn") reason = "Liquidity withdrawal observed";
    if (
      eventName === "ModifyLiquidity" &&
      args.id.toLowerCase() === (position.watchPool ?? position.pool).toLowerCase() &&
      args.liquidityDelta < 0n
    )
      reason = "V4 liquidity withdrawal observed";
    if (eventName === "Sync") {
      const funding = Number(position.funding0 ? args.reserve0 : args.reserve1) / 1e18;
      if (previousFunding > 0 && funding <= previousFunding * 0.9)
        reason = "Funding reserves fell at least 10%";
      nextFunding = Math.max(previousFunding ?? 0, funding);
    }
  }
  return {
    nextFunding,
    alert: reason
      ? {
          pool: position.pool,
          token: position.token,
          reason,
          block: String(BigInt(log.blockNumber)),
          transactionHash: log.transactionHash,
        }
      : null,
  };
}
/** Poll the head once per second and cover EVERY intervening block. Logs can only
 * detect a rug after inclusion; they cannot guarantee an exit before removal. */
export function createRiskMonitor(client, now = Date.now, saved = {}) {
  let positions = [],
    busy = null,
    timer = null,
    lastSuccess = 0,
    lastBlock = null,
    error = null;
  const cursors = new Map((saved.cursors ?? []).map(([id, n]) => [id, BigInt(n)])),
    funding = new Map(saved.funding ?? []),
    alerts = new Map(saved.alerts ?? []);
  const scan = async () => {
    try {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      for (const p of positions) {
        if (!positions.some((current) => current.pool === p.pool)) continue;
        let cursor = cursors.get(p.pool) ?? BigInt(p.entryBlock);
        if (cursor > head + 1n)
          throw new Error("Block monitor head moved backwards; entries paused");
        let chunks = 0;
        while (cursor <= head && chunks++ < 8) {
          const end = cursor + 1999n < head ? cursor + 1999n : head;
          const poolFilter =
            p.dex === "uniswap-v4-robinhood" ||
            p.dex === "pons-v2-dex" ||
            p.watchPool?.length === 66
              ? { address: CONTRACTS.v4PoolManager, topics: [null, p.watchPool ?? p.pool] }
              : { address: p.pool };
          const filter = {
            fromBlock: "0x" + cursor.toString(16),
            toBlock: "0x" + end.toString(16),
          };
          const [poolLogs, tokenLogs, factoryLogs] = await Promise.all([
            client.request({ method: "eth_getLogs", params: [{ ...filter, ...poolFilter }] }),
            client.request({ method: "eth_getLogs", params: [{ ...filter, address: p.token }] }),
            p.factory
              ? client.request({
                  method: "eth_getLogs",
                  params: [
                    {
                      ...filter,
                      address: p.factory,
                      topics: [null, "0x" + p.token.slice(2).padStart(64, "0")],
                    },
                  ],
                })
              : Promise.resolve([]),
          ]);
          if (!positions.some((current) => current.pool === p.pool)) break;
          const logs = [...poolLogs, ...tokenLogs, ...factoryLogs].sort(
            (a, b) =>
              Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
              Number(BigInt(a.logIndex) - BigInt(b.logIndex)),
          );
          for (const log of logs) {
            if (log.removed) throw new Error("Removed log observed; block monitor requires review");
            const result = riskFromLog(log, p, funding.get(p.pool) ?? p.entryDepthEth / 2);
            if (result.nextFunding !== undefined) funding.set(p.pool, result.nextFunding);
            if (result.alert) alerts.set(p.pool, result.alert);
          }
          cursor = end + 1n;
          cursors.set(p.pool, cursor);
        }
        if (cursor <= head) throw new Error("Block monitor catching up; entries paused");
      }
      lastBlock = String(head);
      lastSuccess = now();
      error = null;
    } catch (e) {
      error = e.shortMessage ?? e.message;
    }
  };
  const poll = () =>
    busy ??
    (busy = scan().finally(() => {
      busy = null;
    }));
  return {
    setPositions(next) {
      const earliest = new Map();
      for (const p of next) {
        const old = earliest.get(p.pool);
        if (!old || BigInt(p.entryBlock) < BigInt(old.entryBlock)) earliest.set(p.pool, p);
      }
      positions = [...earliest.values()];
      const ids = new Set(positions.map((p) => p.pool));
      for (const key of cursors.keys())
        if (!ids.has(key)) {
          cursors.delete(key);
          funding.delete(key);
          alerts.delete(key);
        }
      for (const key of alerts.keys()) if (!ids.has(key)) alerts.delete(key);
    },
    poll,
    start() {
      if (!timer) {
        timer = setInterval(() => {
          void poll();
        }, 1000);
        timer.unref();
      }
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (busy) await busy;
    },
    get snapshot() {
      return {
        healthy: !error && lastSuccess > 0 && now() - lastSuccess <= 10000,
        lastSuccessfulAt: lastSuccess,
        lastBlock,
        error,
        alerts: [...alerts.values()],
      };
    },
    get checkpoint() {
      return {
        cursors: [...cursors].map(([id, n]) => [id, String(n)]),
        funding: [...funding],
        alerts: [...alerts],
      };
    },
  };
}
