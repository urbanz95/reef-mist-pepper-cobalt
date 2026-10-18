import assert from "node:assert/strict";
import { it } from "node:test";
import { createPoolProvider } from "./live-paper/provider.mjs";
import { MEME_WATCHLIST, selectProbePools } from "./live-paper/universe.mjs";
it("memecoin lookups share the discovery budget and retain timestamps across the full cycle", async () => {
  let now = 0;
  const calls = [];
  const provider = createPoolProvider(
    async (path) => {
      calls.push(path);
      return { pools: [{ id: path, fetchedAt: now }], fetchedAt: now, providerAgeSec: 0 };
    },
    () => now,
  );
  for (let i = 0; i < 6; i++) {
    now = i * 65000;
    await provider.discover();
    await provider.discover();
  }
  assert.equal(calls.length, 6);
  assert.match(calls[3], new RegExp(MEME_WATCHLIST[0].pool));
  assert.match(calls[4], new RegExp(MEME_WATCHLIST[1].pool));
  assert.equal(calls[5], calls[0]);
  const snapshot = await provider.discover();
  assert.equal(snapshot.pools.length, 5);
  assert.equal(snapshot.pools.find((p) => p.id === calls[3]).fetchedAt, 195000);
});
it("eligible memecoins receive probe slots without exceeding six pools or two tiers per token", () => {
  const ordinary = Array.from({ length: 8 }, (_, i) => ({
    id: String(i),
    other: String(Math.floor(i / 3)),
  }));
  const meme = MEME_WATCHLIST.map((m) => ({ id: m.pool, other: m.token }));
  const selected = selectProbePools([...ordinary, ...meme]);
  assert.equal(selected.length, 6);
  for (const p of meme) assert.ok(selected.includes(p));
  assert.equal(selected.filter((p) => p.other === "0").length, 2);
  assert.ok(
    !selectProbePools(ordinary).some((p) => meme.includes(p)),
    "selection cannot reintroduce an ineligible pool",
  );
  const leaders = Array.from({ length: 6 }, (_, i) => ({ id: `leader-${i}`, other: `token-${i}` }));
  assert.ok(
    !selectProbePools([...leaders, { id: "fake", other: "unknown", label: "MEME" }]).some(
      (p) => p.id === "fake",
    ),
    "a matching ticker cannot claim a reserved slot",
  );
});
it("discovery rotates pages without bursting and keeps original timestamps", async () => {
  let now = 0;
  const calls = [];
  const provider = createPoolProvider(
    async (path) => {
      calls.push(path);
      return {
        pools: [{ id: String(calls.length), fetchedAt: now }],
        fetchedAt: now,
        providerAgeSec: 0,
      };
    },
    () => now,
  );
  await provider.discover();
  for (now = 1000; now < 65000; now += 1000) await provider.discover();
  assert.equal(calls.length, 1);
  const held = await provider.currentPool("1");
  assert.equal(held.fetchedAt, 0);
  assert.equal(calls.length, 1);
  now = 65000;
  await provider.discover();
  now = 130000;
  const all = await provider.discover();
  assert.equal(all.pools.length, 3);
  assert.equal(all.pools[0].fetchedAt, 0);
  assert.match(calls[0], /page=1/);
  assert.match(calls[1], /page=2/);
  assert.match(calls[2], /page=3/);
});
it("rate limits preserve successful pages, honor retry-after, and back off after repeated failures", async () => {
  let now = 0,
    calls = 0;
  const provider = createPoolProvider(
    async () => {
      calls++;
      if (calls > 1) throw Object.assign(new Error("HTTP 429"), { retryAfterMs: 120000 });
      return { pools: [{ id: "kept", fetchedAt: 0 }], fetchedAt: 0, providerAgeSec: 0 };
    },
    () => now,
  );
  await provider.discover();
  now = 65000;
  await assert.rejects(provider.discover());
  for (now = 66000; now < 185000; now += 1000) {
    const cached = await provider.discover();
    assert.equal(cached.pools[0].fetchedAt, 0);
  }
  assert.equal(calls, 2);
  await assert.rejects(provider.discover());
  now = now + 120000;
  await provider.discover();
  assert.equal(calls, 3, "exponential delay now exceeds retry-after");
  await assert.rejects(provider.currentPool("missing"));
  assert.equal(calls, 3);
});
it("a restored or disappeared held pool stays known without consuming the HTTP budget or refreshing metadata", async () => {
  let calls = 0;
  const provider = createPoolProvider(
    async () => {
      calls++;
      return { pools: [], fetchedAt: 100, providerAgeSec: 0 };
    },
    () => 100,
  );
  provider.seed([{ id: "held", fetchedAt: 0, wethUsd: 2000 }]);
  await provider.discover();
  const result = await provider.currentPool("held");
  assert.equal(calls, 1);
  assert.equal(result.pools[0].wethUsd, 2000);
  assert.equal(result.fetchedAt, 0);
});
