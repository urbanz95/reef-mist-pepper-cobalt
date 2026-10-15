import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rankForHunt } from "./degen-logic.ts";
import { WETH, type Pool } from "./pools.ts";

function pool(tag: string, tvlUsd: number, volume24h: number, feePct = 0.3): Pool {
  const id = `0x${tag.padStart(40, "0")}`;
  return {
    id,
    version: "v3",
    kind: "meme",
    venue: "uniswap",
    feePct,
    tvlUsd,
    volume24h,
    volume1h: 0,
    priceUsd: 1,
    quotePriceUsd: 1,
    tokenA: { symbol: "AAA", name: "AAA", address: id, decimals: 18 },
    tokenB: WETH,
  } as unknown as Pool;
}

it("discovery ranks 24h fees and ignores one-hour spikes", () => {
  const a = { ...pool("a", 200000, 10000), volume1h: 1000000 };
  const b = pool("b", 200000, 20000);
  assert.equal(rankForHunt([a, b], "meme", true)[0].id, b.id);
});
it("discovery excludes pools that cannot be executed on v3 WETH", () => {
  const a = pool("a", 200000, 10000);
  assert.equal(rankForHunt([{ ...a, venue: "launchpad" }], "meme", true).length, 0);
  assert.equal(rankForHunt([{ ...a, version: "v4" }], "meme", true).length, 0);
});
