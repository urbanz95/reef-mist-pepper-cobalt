import { parseAbiItem } from "viem";
import { CONTRACTS } from "../../src/lib/chain.ts";
const events = {
  2: "event PairCreated(address indexed token0,address indexed token1,address pair,uint256)",
  3: "event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)",
  4: "event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)",
};
/** Pool creation evidence is NOT a launchpad graduation/migration event. */
export async function poolCreationEvidence(client, poolId, version, key, snapshot) {
  try {
    const address = { 2: CONTRACTS.v2Factory, 3: CONTRACTS.v3Factory, 4: CONTRACTS.v4PoolManager }[
      version
    ].toLowerCase();
    const block = BigInt(snapshot.block);
    const args =
      version === 4
        ? { id: poolId }
        : {
            token0: key.currency0,
            token1: key.currency1,
            ...(version === 3 ? { fee: key.fee } : {}),
          };
    const logs = await client.getLogs({
      address,
      event: parseAbiItem(events[version]),
      args,
      fromBlock: block > 5000n ? block - 5000n : 0n,
      toBlock: block,
      strict: true,
    });
    const log = logs.find(
      (l) =>
        l.address.toLowerCase() === address &&
        String(
          version === 4 ? l.args.id : version === 3 ? l.args.pool : l.args.pair,
        ).toLowerCase() === poolId.toLowerCase(),
    );
    if (!log) return { status: "not_found_in_recent_blocks", migrationStatus: "unconfirmed" };
    return {
      status: "pool_creation_verified",
      migrationStatus: "unconfirmed",
      transactionHash: log.transactionHash,
      blockNumber: String(log.blockNumber),
      emitter: address,
      ...(version === 4
        ? {
            key: {
              currency0: log.args.currency0,
              currency1: log.args.currency1,
              fee: log.args.fee,
              tickSpacing: log.args.tickSpacing,
              hooks: log.args.hooks,
            },
          }
        : {}),
    };
  } catch {
    return { status: "creation_lookup_unavailable", migrationStatus: "unconfirmed" };
  }
}
