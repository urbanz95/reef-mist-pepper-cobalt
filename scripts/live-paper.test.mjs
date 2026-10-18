import assert from "node:assert/strict";
import { it } from "node:test";
import { newLiveBook, stepLiveBook, fullRangeValue } from "../src/lib/live-paper.ts";
import { readOnlyProvider, normalizePools } from "./live-paper/market.mjs";
import { CONTRACTS } from "../src/lib/chain.ts";
const start = 2_000_000_000_000;
function point(now, patch = {}) {
  return {
    id: "pool",
    label: "Pool",
    priceEth: 1,
    fetchedAt: now,
    apr: 100,
    tvlUsd: 500000,
    createdAt: start - 86400000 * 10,
    reviewed: true,
    factoryVerified: true,
    roundTripOk: true,
    costEth: 0.000002,
    entryCostEth: 0.000001,
    exitCostEth: 0.000001,
    ...patch,
  };
}
function enter() {
  let book = newLiveBook(0.1);
  for (let i = 0; i <= 10; i++)
    book = stepLiveBook(book, [point(start + i * 15000)], start + i * 15000).book;
  assert.equal(book.state.current, "pool");
  return book;
}
it("RPC wrapper refuses every signing, write and wallet method before transport", async () => {
  const calls = [];
  const rpc = readOnlyProvider({
    request: async (a) => {
      calls.push(a.method);
      return "ok";
    },
  });
  for (const method of [
    "eth_sendTransaction",
    "eth_sendRawTransaction",
    "eth_sign",
    "personal_sign",
    "wallet_addEthereumChain",
    "anvil_setBalance",
  ])
    await assert.rejects(rpc.request({ method, params: [] }));
  assert.deepEqual(calls, []);
  assert.equal(await rpc.request({ method: "eth_call", params: [] }), "ok");
});
it("live paper starts with real spaced confirmations, then accounts for costs and a price stop", () => {
  const b = enter();
  assert.ok(b.costs > 0);
  assert.ok(b.value < 0.1);
  const now = start + 165000;
  const { book, decision } = stepLiveBook(b, [point(now, { priceEth: 0.81 })], now);
  assert.equal(decision.action, "exit");
  assert.equal(book.position, null);
  assert.equal(book.state.halted, true);
  assert.ok(book.value < 0.095);
  assert.ok(book.costs > b.costs);
  assert.equal(book.cash, book.value);
});
it("missing or stale prices produce unknown valuation and never fictitious realized proceeds", () => {
  const b = enter();
  const now = start + 165000;
  for (const points of [[], [point(now - 61000)], [point(now, { roundTripOk: false })]]) {
    const r = stepLiveBook(b, points, now);
    assert.equal(r.book.value, null);
    assert.equal(r.book.cash, 0);
    assert.equal(r.decision.action, "blocked");
    assert.equal(r.book.fees, b.fees);
  }
});
it("monitoring gaps earn no modeled fees and reset entry confirmations", () => {
  const b = enter(),
    now = b.lastAt + 120000;
  const r = stepLiveBook(b, [point(now)], now);
  assert.equal(r.book.fees, b.fees);
  assert.equal(r.decision.action, "blocked");
  let empty = newLiveBook(0.1);
  empty = stepLiveBook(empty, [point(start)], start).book;
  empty = stepLiveBook(empty, [point(start + 15000)], start + 15000).book;
  const gap = stepLiveBook(empty, [point(start + 180000)], start + 180000);
  assert.equal(gap.book.state.challenger, null);
});
it("liquidity shock exits without waiting for the cooldown; stop stays latched", () => {
  const b = enter(),
    now = b.lastAt + 15000;
  const r = stepLiveBook(b, [point(now, { tvlUsd: 100000 })], now);
  assert.equal(r.decision.action, "exit");
  assert.equal(stepLiveBook(r.book, [point(now + 15000)], now + 15000).decision.action, "blocked");
});
it("full-range approximation is denominated in ETH and includes impermanent-loss shape", () => {
  assert.equal(fullRangeValue(1, 1, 4), 2);
  assert.equal(fullRangeValue(1, 1, 0.25), 0.5);
  assert.throws(() => fullRangeValue(1, 0, 1));
  assert.throws(() => newLiveBook(NaN));
  assert.throws(() => newLiveBook(1));
});
it("provider parsing rejects malformed / non-WETH data and has no catalog fallback", () => {
  assert.deepEqual(normalizePools({}), []);
  const token = "0x" + "12".repeat(20),
    pool = "0x" + "34".repeat(20);
  const json = {
    included: [
      { type: "token", id: "a", attributes: { address: CONTRACTS.weth } },
      { type: "token", id: "b", attributes: { address: token } },
    ],
    data: [
      {
        attributes: {
          address: pool,
          reserve_in_usd: "200000",
          volume_usd: { h24: "100000" },
          pool_created_at: "2025-01-01",
        },
        relationships: { base_token: { data: { id: "a" } }, quote_token: { data: { id: "b" } } },
      },
    ],
  };
  assert.equal(normalizePools(json)[0].other, token);
  json.data[0].attributes.reserve_in_usd = "not-a-number";
  assert.deepEqual(normalizePools(json), []);
});

it("carry48 can enter a fee opportunity rejected by six-hour economics without removing safety gates", () => {
  let baseline = newLiveBook(0.1),
    carry = newLiveBook(0.1, "carry48");
  for (let i = 0; i < 24; i++) {
    const now = start + i * 15000,
      points = [
        point(now, { apr: 30, costEth: 0.00003, entryCostEth: 0.00002, exitCostEth: 0.00001 }),
      ];
    baseline = stepLiveBook(baseline, points, now).book;
    carry = stepLiveBook(carry, points, now).book;
  }
  assert.equal(baseline.position, null);
  assert.ok(carry.position);
  const now = carry.lastAt + 15000;
  const profit = stepLiveBook(
    carry,
    [point(now, { priceEth: 1.01, costEth: 0.00003, exitCostEth: 0.00001 })],
    now,
  );
  assert.equal(profit.decision.action, "exit");
  assert.match(profit.decision.reason, /profit target/);
  assert.ok(profit.book.value > 0.1);
  assert.equal(profit.book.state.halted, false);
  const timeout = stepLiveBook(
    { ...carry, enteredAt: now - 48 * 3600000 },
    [point(now, { exitCostEth: 0.00001 })],
    now,
  );
  assert.equal(timeout.decision.action, "exit");
  assert.match(timeout.decision.reason, /exposure limit/);
  const unavailable = stepLiveBook(carry, [], now);
  assert.equal(unavailable.book.value, null);
  assert.equal(unavailable.decision.action, "blocked");
});
it("carry48 refuses a recent falling price and does not count missing samples as confirmations", () => {
  let book = newLiveBook(0.1, "carry48");
  for (let i = 0; i < 12; i++) {
    const now = start + i * 15000;
    book = stepLiveBook(book, [point(now, { priceEth: 1 - i * 0.002 })], now).book;
  }
  assert.equal(book.position, null);
  const now = book.lastAt + 15000;
  book.state.challenger = "pool";
  book.state.observations = 2;
  book.state.lastObservationAt = now - 15000;
  book.state.challengerSince = now - 60000;
  const missing = stepLiveBook(book, [], now);
  assert.equal(missing.decision.action, "blocked");
  assert.equal(missing.book.state.observations, 2);
  const long = stepLiveBook(missing.book, [], now + 60000);
  assert.equal(long.book.state.challenger, null);
});

it('profitable carry exits permit a later cycle while position PnL reconciles to the book',()=>{
 let book=newLiveBook(.1,'carry48');
 for(let i=0;i<24;i++)book=stepLiveBook(book,[point(start+i*15000)],start+i*15000).book;
 const now=book.lastAt+15000;
 const result=stepLiveBook(book,[point(now,{priceEth:1.01})],now);
 assert.equal(result.decision.action,'exit');assert.equal(result.book.state.halted,false);
 assert.equal(result.book.ledger.length,1);assert.ok(result.book.ledger[0].exitAt);
 assert.ok(Math.abs(result.book.ledger[0].pnlEth-(result.book.value-.1))<1e-12);
 assert.equal(stepLiveBook(result.book,[point(now+15000)],now+15000).decision.reason,'Minimum holding period');
 book=result.book;
 for(let i=0;i<24;i++){
  const at=now+31*60000+i*15000;book=stepLiveBook(book,[point(at)],at).book;
 }
 assert.ok(book.position);assert.equal(book.ledger.length,2);
 assert.equal(book.ledger.filter(t=>!t.exitAt).length,1);
 assert.ok(Math.abs(book.ledger.reduce((sum,t)=>sum+t.pnlEth,0)-(book.value-.1))<1e-12);
});

it('expired provider metadata blocks new entry but fresh chain prices still permit protective exits',()=>{
 const b=enter(),now=b.lastAt+15000;
 const result=stepLiveBook(b,[point(now,{priceEth:.8,reviewed:false,metadataFresh:false})],now);
 assert.equal(result.decision.action,'exit');assert.equal(result.book.position,null);
 assert.equal(result.book.fees,b.fees,'no modeled fees accrue from expired volume data');
 let empty=newLiveBook(.1,'carry48');
 for(let i=0;i<24;i++){
  const at=start+i*15000;
  empty=stepLiveBook(empty,[point(at,{metadataFresh:false,reviewed:false})],at).book;
 }
 assert.equal(empty.position,null);
});
it('fresh ETH reserves detect a liquidity shock independently of cached USD conversion',()=>{
 let b=newLiveBook(.1);
 for(let i=0;i<12;i++){const at=start+i*15000;b=stepLiveBook(b,[point(at,{reserveEth:100})],at).book;}
 const now=b.lastAt+15000;
 const unchanged=stepLiveBook(b,[point(now,{reserveEth:100,tvlUsd:200000})],now);
 assert.notEqual(unchanged.decision.action,'exit','a USD-reference change is not a reserve withdrawal');
 const removed=stepLiveBook(b,[point(now,{reserveEth:60})],now);
 assert.equal(removed.decision.action,'exit');assert.match(removed.decision.reason,/liquidity/);
});
