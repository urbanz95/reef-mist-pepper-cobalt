import assert from "node:assert/strict";
import { it } from "node:test";
import { newLiveBook, stepLiveBook } from "../src/lib/live-paper.ts";
import { validateGuardedCheckpoint } from "../src/lib/guarded-paper.ts";
import { PAPER_ROTATION } from "../src/lib/paper-risk.ts";

// Quote evidence from run 39381049084, first-half raw sample at block93247156.
// The admission history below is a controlled fixture, not a historical fill or
// a backtest. It isolates costs and stop accounting without external RPC/funds.
const pool = "0x77ea11bbfb8f1259c702cb0ebc2105b7c007db89cf30c2f1a8776886a4467c07";
const token = "0xdee52f2ab639b6942b0d0f0565400b93b7a0fbe5";
const quantityRaw = "2535014794661241998516";
const now = 1792478070000;
const budget = 0.002,
  input = 0.0019;
const entryGas = 0.0000050350572,
  exitGas = 0.000004773799692;
const proceeds = 0.001861910841302064;
const reserve = budget - input - entryGas;
const entryNet = proceeds + reserve - exitGas;

function exactSale(at, net = entryNet) {
  return {
    pool,
    quantityRaw,
    receivedEth: net - reserve + exitGas,
    gasEth: exitGas,
    fetchedAt: at,
    block: "93247157",
  };
}

function lowCostConfirmedEntry() {
  const book = newLiveBook(0.1, "guarded");
  book.lastAt = now - 5000;
  book.prices = [
    { id: pool, at: now - 90000, price: 1 },
    { id: pool, at: now - 60000, price: 1.02 },
    { id: pool, at: now - 30000, price: 1.04 },
    { id: pool, at: now - 15000, price: 1.05 },
  ];
  book.challenges[pool] = { since: now - 30000, lastAt: now - 15000, observations: 2 };
  const point = {
    id: pool,
    token,
    label: "HARMONIC / WETH",
    priceEth: 1.06,
    fetchedAt: now,
    apr: 0,
    tvlUsd: 142000,
    createdAt: now - 100000,
    reviewed: true,
    factoryVerified: true,
    roundTripOk: true,
    metadataFresh: true,
    reserveEth: 50.436435926981076,
    block: "93247156",
    costEth: 0.000003,
    entryCostEth: 0.000002,
    exitCostEth: 0.000001,
    buyInputEth: input,
    buyGasEth: 0.000001,
    quantityRaw,
    entryExitQuote: {
      ...exactSale(now),
      receivedEth: 0.001899,
      gasEth: 0.000001,
      block: "93247156",
    },
    security: {
      token,
      liquidityBlock: "93247156",
      status: "approved",
      checkedAt: now,
      reasons: [],
      actors: ["0x046c58b10eef3b19154da71955815f05c0010a8a"],
      source: "controlled fixture with recorded execution costs",
    },
  };
  const result = stepLiveBook(book, [point], now, { monitorHealthy: true });
  assert.equal(
    result.book.positions.length,
    1,
    "the low-cost fill fits the current admission limit",
  );
  assert.equal(result.book.ledger.length, 1);
  validateGuardedCheckpoint(result.book);
  return result.book;
}

function historicalCostPosition() {
  // Restored/manual fixture: a stricter NEW-entry cap must not prevent the
  // engine from managing an existing higher-cost position correctly.
  const book = newLiveBook(0.1, "guarded"),
    id = "recorded-cost-position";
  book.cash -= budget;
  book.costs = entryGas;
  book.lastAt = now;
  book.value = book.cash + entryNet;
  book.positions.push({
    id,
    pool,
    token,
    label: "HARMONIC / WETH",
    quantityRaw,
    allocationEth: budget,
    inputEth: input,
    entryGasEth: entryGas,
    exitReserveEth: reserve,
    entryAt: now,
    entryBlock: "93247156",
    entryDepthEth: 50.436435926981076,
    highWaterEth: entryNet,
    markedValueEth: entryNet,
    actors: ["0x046c58b10eef3b19154da71955815f05c0010a8a"],
    lastQuoteAt: now,
  });
  book.state.current = pool;
  book.state.lastTradeAt = now;
  book.state.trades = [now];
  book.ledger = [
    {
      id,
      capital: 0.1,
      pool,
      label: "HARMONIC / WETH",
      entryAt: new Date(now).toISOString(),
      exitAt: null,
      entryValueEth: budget,
      valueEth: entryNet,
      durationSec: 0,
      feesEth: 0,
      costsEth: entryGas,
      pnlEth: entryNet - budget,
      exitReason: null,
      feeBaseline: 0,
      quantityRaw,
    },
  ];
  validateGuardedCheckpoint(book);
  return book;
}

it("a new eligible entry establishes its high-water from the measured liquidation mark", () => {
  const entered = lowCostConfirmedEntry(),
    position = entered.positions[0];
  assert.ok(position.markedValueEth < position.allocationEth);
  assert.equal(position.highWaterEth, position.markedValueEth);
});

it("a measured 2.39% entry friction establishes the liquidation high-water and does not cause an immediate trailing exit", () => {
  assert.ok(entryNet < budget * 0.98 && entryNet > budget * 0.97);
  const entered = historicalCostPosition();
  assert.ok(Math.abs(entered.positions[0].highWaterEth - entryNet) < 1e-15);
  const unchanged = stepLiveBook(entered, [], now + 5000, {
    monitorHealthy: true,
    exitQuotes: [exactSale(now + 5000)],
  });
  assert.equal(unchanged.book.positions.length, 1);
  assert.equal(unchanged.book.ledger[0].exitAt, null);
  assert.equal(unchanged.book.costs, entryGas);
  assert.equal(unchanged.book.state.halted, false);
  validateGuardedCheckpoint(unchanged.book);
});

it("a later genuine loss still closes at the absolute allocation loss cap with exact proceeds and gas", () => {
  const entered = historicalCostPosition(),
    at = now + 5000,
    net = 0.00193;
  const stopped = stepLiveBook(entered, [], at, {
    monitorHealthy: true,
    exitQuotes: [exactSale(at, net)],
  });
  assert.equal(stopped.book.positions.length, 0);
  const trade = stopped.book.ledger[0];
  assert.equal(trade.quantityRaw, quantityRaw);
  assert.equal(trade.exitAt, new Date(at).toISOString());
  assert.match(trade.exitReason, /loss \/ trailing stop/);
  assert.ok(Math.abs(trade.pnlEth - (net - budget)) < 1e-15);
  assert.equal(stopped.book.costs, entryGas + exitGas);
  validateGuardedCheckpoint(stopped.book);
});

it("a real liquidation high-water drawdown can stop above the absolute loss floor", () => {
  const entered = historicalCostPosition(),
    peak = 0.001997;
  const gained = stepLiveBook(entered, [], now + 5000, {
    monitorHealthy: true,
    exitQuotes: [exactSale(now + 5000, peak)],
  });
  assert.equal(gained.book.positions.length, 1);
  assert.ok(Math.abs(gained.book.positions[0].highWaterEth - peak) < 1e-15);
  const net = 0.00195;
  assert.ok(net > budget * (1 - PAPER_ROTATION.stopLoss));
  assert.ok(net < peak * (1 - PAPER_ROTATION.trailingLoss));
  const trailed = stepLiveBook(gained.book, [], now + 10000, {
    monitorHealthy: true,
    exitQuotes: [exactSale(now + 10000, net)],
  });
  assert.equal(trailed.book.positions.length, 0);
  assert.match(trailed.book.ledger[0].exitReason, /loss \/ trailing stop/);
  validateGuardedCheckpoint(trailed.book);
});

it("net profit and exposure timeout settle the held quantity and each gas leg once despite initial trading friction", () => {
  const entered = historicalCostPosition(),
    at = now + 5000,
    profitNet = 0.002022;
  const profit = stepLiveBook(entered, [], at, {
    monitorHealthy: true,
    exitQuotes: [exactSale(at, profitNet)],
  });
  assert.equal(profit.book.positions.length, 0);
  assert.match(profit.book.ledger[0].exitReason, /net profit target/);
  assert.ok(Math.abs(profit.book.ledger[0].pnlEth - (profitNet - budget)) < 1e-15);
  assert.equal(profit.book.ledger[0].quantityRaw, quantityRaw);
  assert.equal(profit.book.costs, entryGas + exitGas);
  validateGuardedCheckpoint(profit.book);

  let timed = historicalCostPosition();
  for (let elapsed = 5000; elapsed <= PAPER_ROTATION.maxHoldMs; elapsed += 5000) {
    timed = stepLiveBook(timed, [], now + elapsed, {
      monitorHealthy: true,
      exitQuotes: [exactSale(now + elapsed)],
    }).book;
    if (elapsed < PAPER_ROTATION.maxHoldMs) assert.equal(timed.positions.length, 1);
  }
  assert.equal(timed.positions.length, 0);
  assert.match(timed.ledger[0].exitReason, /exposure limit/);
  assert.equal(timed.ledger[0].exitAt, new Date(now + PAPER_ROTATION.maxHoldMs).toISOString());
  assert.ok(Math.abs(timed.ledger[0].pnlEth - (entryNet - budget)) < 1e-15);
  assert.equal(timed.costs, entryGas + exitGas);
  validateGuardedCheckpoint(timed);
});

it("an absent, stale or wrong-quantity held sale remains open with unknown value rather than inventing a stop fill", () => {
  for (const quotes of [
    [],
    [exactSale(now - 20000)],
    [{ ...exactSale(now + 5000), quantityRaw: "1" }],
  ]) {
    const entered = historicalCostPosition();
    const unknown = stepLiveBook(entered, [], now + 5000, {
      monitorHealthy: true,
      exitQuotes: quotes,
    });
    assert.equal(unknown.book.positions.length, 1);
    assert.equal(unknown.book.positions[0].quantityRaw, quantityRaw);
    assert.equal(unknown.book.value, null);
    assert.equal(unknown.book.ledger[0].exitAt, null);
    assert.equal(unknown.book.ledger[0].pnlEth, null);
    assert.equal(unknown.book.costs, entryGas);
    validateGuardedCheckpoint(unknown.book);
  }
});
