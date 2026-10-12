import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { beats, pickHop } from "./degen-logic.ts";
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

const ID_A = `0x${"a".padStart(40, "0")}`;
const ID_B = `0x${"b".padStart(40, "0")}`;

describe("beats", () => {
  it("requires a meaningful margin, not just noise", () => {
    assert.equal(beats(10.5, 10), false); // 5% relative, under the 8% floor
    assert.equal(beats(11, 10), true); // 10% relative
    assert.equal(beats(0, 10), false);
    assert.equal(beats(5, 0), true);
  });
});

describe("pickHop", () => {
  it("enters the best pool when there is no current position", () => {
    const pools = [pool("a", 20_000, 1_000), pool("b", 20_000, 5_000)];
    const target = pickHop({ pools, universe: "meme", onchain: true, currentPoolId: null });
    assert.equal(target?.id, ID_B);
  });

  it("does not hop to itself or to a pool that is not meaningfully better", () => {
    const pools = [pool("a", 20_000, 5_000), pool("b", 20_000, 5_050)];
    assert.equal(pickHop({ pools, universe: "meme", onchain: true, currentPoolId: ID_A }), null);
  });

  it("hops immediately once a pool is meaningfully ahead — no confirmation delay", () => {
    const pools = [pool("a", 20_000, 1_000), pool("b", 20_000, 10_000)];
    const target = pickHop({ pools, universe: "meme", onchain: true, currentPoolId: ID_A });
    assert.equal(target?.id, ID_B);
  });

  it("ignores launchpad pools that cannot be minted on Uniswap v3", () => {
    const launchpad = { ...pool("a", 20_000, 10_000), venue: "launchpad" } as unknown as Pool;
    assert.equal(pickHop({ pools: [launchpad], universe: "meme", onchain: true, currentPoolId: null }), null);
  });
});
