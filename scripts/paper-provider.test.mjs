import assert from "node:assert/strict";
import { it } from "node:test";
import { createPoolProvider } from "./live-paper/provider.mjs";
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
