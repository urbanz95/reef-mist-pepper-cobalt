import { it } from "node:test";
import assert from "node:assert/strict";
import { createSecurityProvider } from "./live-paper/security-provider.mjs";
import { selectGuardedPools, PONS_DISCOVERY_PATHS } from "./live-paper/universe.mjs";
const addr = (n) => "0x" + n.toString(16).padStart(40, "0");
const t0 = Date.parse("2026-10-19T12:00:00Z");
function harness(handler) {
  let now = t0;
  const calls = [];
  const provider = createSecurityProvider(
    async (url) => {
      const token = new URL(url).searchParams.get("contract_addresses");
      calls.push({ token, at: now });
      return handler(token, calls.length);
    },
    () => now,
    {
      wait: async (ms) => {
        now += ms;
      },
    },
  );
  return {
    provider,
    calls,
    tick: (ms) => {
      now += ms;
    },
    time: () => now,
  };
}
it("single-address requests cover all six candidates and retain fresh evidence through a four-minute confirmation window", async () => {
  const tokens = Array.from({ length: 8 }, (_, i) => addr(i + 1));
  const h = harness((token) =>
    Response.json({ code: 1, result: { [token]: { is_open_source: "1", token_name: token } } }),
  );
  for (let i = 0; i < 50; i++) {
    await h.provider.refresh(tokens);
    if (i >= 4)
      for (const token of tokens) {
        assert.equal(h.provider.dataStatus(token).status, "available");
        assert.equal(h.provider.get(token).raw.token_name, token);
        assert.ok(h.time() - h.provider.get(token).checkedAt < 60000);
      }
    h.tick(5000);
  }
  assert.ok(h.calls.every((c) => !c.token.includes(",")));
  assert.ok(new Set(h.calls.slice(0, 8).map((c) => c.token)).size === 8);
  for (let i = 1; i < h.calls.length; i++) assert.ok(h.calls[i].at - h.calls[i - 1].at >= 2100);
  for (const c of h.calls)
    assert.ok(h.calls.filter((x) => x.at >= c.at && x.at < c.at + 60000).length <= 30);
});
it("an omitted or wrong token response cannot borrow another token's data or refresh earlier evidence", async () => {
  let omit = false;
  const h = harness((token) =>
    Response.json({
      code: 1,
      result: omit
        ? { [addr(99)]: { is_open_source: "1" } }
        : { [token.toUpperCase()]: { is_open_source: "1" } },
    }),
  );
  await h.provider.refresh([addr(1)]);
  const checkedAt = h.provider.get(addr(1)).checkedAt;
  omit = true;
  h.tick(30000);
  await h.provider.refresh([addr(1), addr(2)]);
  assert.equal(h.provider.get(addr(1)).checkedAt, checkedAt);
  assert.equal(h.provider.dataStatus(addr(2)).status, "missing");
  assert.equal(h.provider.get(addr(2)).checkedAt, 0);
  h.tick(31000);
  assert.equal(h.provider.dataStatus(addr(1)).status, "stale");
  assert.ok(h.provider.snapshot.missing >= 1);
});
it("held tokens approaching expiry are refreshed ahead of newly discovered diagnostics", async () => {
  const h = harness((token) =>
    Response.json({ code: 1, result: { [token]: { is_open_source: "1" } } }),
  );
  await h.provider.refresh([addr(8)]);
  h.tick(45000);
  await h.provider.refresh([addr(1), addr(2), addr(8)], { priorityTokens: [addr(8)] });
  assert.equal(h.calls[1].token, addr(8));
  assert.equal(h.provider.dataStatus(addr(8)).status, "available");
});
it("concurrent refreshes share the same paced worker; missing records are not retried every sample", async () => {
  const h = harness(() => Response.json({ code: 1, result: {} }));
  await Promise.all([
    h.provider.refresh([addr(1), addr(2)]),
    h.provider.refresh([addr(1), addr(2)]),
  ]);
  assert.equal(h.calls.length, 2);
  h.tick(5000);
  await h.provider.refresh([addr(1), addr(2)]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.provider.snapshot.missingTokens, 2);
  assert.equal(h.provider.dataStatus(addr(99)).status, "not_requested");
});
it("unsupported and invalid token results cannot freeze another token's security refresh", async () => {
  for (const data of [
    { code: 2, message: "Data pending sync" },
    { code: 2004, message: "Address format error" },
    { code: 2018, message: "Chain not supported" },
    { code: 2020, message: "Non-contract address" },
    { code: 2021, message: "Contract info not found" },
    { code: 2022, message: "The main chain is not supported" },
    { code: 1, result: null },
    { code: 1, result: [] },
  ]) {
    const h = harness((token) =>
      token === addr(1)
        ? Response.json(data)
        : Response.json({ code: 1, result: { [token]: { is_open_source: "1" } } }),
    );
    await h.provider.refresh([addr(1), addr(2)]);
    assert.equal(h.calls.length, 2, JSON.stringify(data));
    assert.ok(h.calls[1].at - h.calls[0].at >= 2100);
    assert.equal(h.provider.dataStatus(addr(1)).status, "error");
    assert.equal(h.provider.dataStatus(addr(1)).providerCode, data.code);
    assert.match(h.provider.dataStatus(addr(1)).detail, new RegExp(`code ${data.code}`));
    assert.equal(h.provider.get(addr(1)).checkedAt, 0);
    assert.equal(h.provider.get(addr(1)).raw, undefined);
    assert.equal(h.provider.dataStatus(addr(2)).status, "available");
    h.tick(5000);
    await h.provider.refresh([addr(1), addr(2)]);
    assert.equal(h.calls.length, 2, "unavailable tokens keep their own retry delay");
  }
});
it("repeated unsupported discoveries preserve held-token priority and its real evidence timestamp", async () => {
  const held = addr(9),
    unsupported = [addr(1), addr(2), addr(3)];
  let heldUnavailable = false;
  const h = harness((token) =>
    token === held && !heldUnavailable
      ? Response.json({ code: 1, result: { [token]: { is_open_source: "1" } } })
      : Response.json({ code: 2021, message: "Contract info not found" }),
  );
  await h.provider.refresh([held]);
  h.tick(25000);
  await h.provider.refresh([...unsupported, held], { priorityTokens: [held] });
  assert.equal(h.calls[1].token, unsupported[0]);
  assert.equal(h.calls[2].token, unsupported[1]);
  h.tick(15000);
  await h.provider.refresh([...unsupported, held], { priorityTokens: [held] });
  assert.equal(h.calls[3].token, held, "held evidence nearing expiry outranks new diagnostics");
  assert.equal(h.provider.dataStatus(held).status, "available");
  const checkedAt = h.provider.get(held).checkedAt;
  heldUnavailable = true;
  h.tick(45000);
  await h.provider.refresh([...unsupported, held], { priorityTokens: [held] });
  assert.equal(h.provider.get(held).checkedAt, checkedAt);
  assert.equal(h.provider.dataStatus(held).providerCode, 2021);
  assert.match(h.provider.dataStatus(held).detail, /Contract info not found/);
  h.tick(16000);
  assert.equal(h.provider.dataStatus(held).status, "stale");
  for (let i = 1; i < h.calls.length; i++) assert.ok(h.calls[i].at - h.calls[i - 1].at >= 2100);
});
it("shared HTTP and GoPlus service failures still stop the queue and back off exponentially", async () => {
  for (const response of [
    () => new Response("", { status: 429 }),
    () => new Response("", { status: 503 }),
    () => Response.json({ code: 4029, message: "Frequency over limit" }),
    () => Response.json({ code: 4010, message: "App key not exist" }),
    () => Response.json({ code: 5000, message: "Server error" }),
    () => Response.json({ code: 9999, message: "Undocumented failure" }),
  ]) {
    const h = harness(response);
    await h.provider.refresh([addr(1), addr(2)]);
    assert.equal(h.calls.length, 1, "shared failures stop the second request");
    h.tick(29999);
    await h.provider.refresh([addr(1), addr(2)]);
    assert.equal(h.calls.length, 1);
    h.tick(1);
    await h.provider.refresh([addr(1), addr(2)]);
    assert.equal(h.calls.length, 2);
    h.tick(59999);
    await h.provider.refresh([addr(1), addr(2)]);
    assert.equal(h.calls.length, 2, "the second shared failure doubles the delay");
    h.tick(1);
    await h.provider.refresh([addr(1), addr(2)]);
    assert.equal(h.calls.length, 3);
    assert.equal(h.provider.snapshot.available, 0);
  }
});
it("Retry-After also applies to HTTP-200 GoPlus rate-limit responses", async () => {
  for (const retry of ["120", new Date(t0 + 120000).toUTCString()]) {
    const h = harness(() =>
      Response.json(
        { code: 4029, message: "Frequency over limit" },
        { headers: { "retry-after": retry } },
      ),
    );
    await h.provider.refresh([addr(1), addr(2)]);
    assert.equal(h.provider.dataStatus(addr(1)).providerCode, 4029);
    assert.match(h.provider.dataStatus(addr(1)).detail, /Frequency over limit/);
    h.tick(119999);
    await h.provider.refresh([addr(1), addr(2)]);
    assert.equal(h.calls.length, 1);
    h.tick(1);
    await h.provider.refresh([addr(1), addr(2)]);
    assert.equal(h.calls.length, 2);
  }
});
it("known unsupported liquidity routes and recent rejections do not occupy six entry-confirmation slots", () => {
  const pools = Array.from({ length: 8 }, (_, i) => ({
    id: addr(i + 1),
    other: addr(i + 100),
    dex: i < 6 ? "uniswap-v4-robinhood" : "pons-v2-dex",
  }));
  const selection = selectGuardedPools(
    pools,
    { startedAt: t0, ids: pools.slice(0, 6).map((p) => p.id) },
    [],
    t0 + 5000,
  );
  assert.deepEqual(
    selection.selected.map((p) => p.id),
    pools.slice(6).map((p) => p.id),
  );
  const coverage = [{ id: pools[6].id, securityStatus: "rejected", securityCheckedAt: t0 }];
  assert.equal(selectGuardedPools(pools, null, coverage, t0 + 5000).selected.length, 1);
  assert.equal(selectGuardedPools(pools, null, coverage, t0 + 60001).selected.length, 2);
  coverage[0] = {
    id: pools[6].id,
    securityStatus: "unknown",
    securityCheckedAt: t0,
    securityData: { status: "available" },
  };
  assert.equal(selectGuardedPools(pools, null, coverage, t0 + 5000).selected.length, 1);
  coverage[0].securityData.status = "pending";
  assert.equal(selectGuardedPools(pools, null, coverage, t0 + 5000).selected.length, 2);
  coverage[0].securityData = { status: "missing", requestedAt: t0 };
  assert.equal(selectGuardedPools(pools, null, coverage, t0 + 5000).selected.length, 1);
  assert.equal(selectGuardedPools(pools, null, coverage, t0 + 30001).selected.length, 2);
  assert.ok(PONS_DISCOVERY_PATHS.some((p) => p.includes("uniswap-v2-robinhood")));
});
