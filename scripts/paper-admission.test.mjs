import { it } from "node:test";
import assert from "node:assert/strict";
import {
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  TimeoutError,
  encodeAbiParameters,
  keccak256,
  parseEther,
} from "viem";
import { CONTRACTS } from "../src/lib/chain.ts";
import { createAdmissionRetry } from "./live-paper/admission.mjs";
import {
  EXIT_WALLET,
  isEntryRejection,
  quoteHeldExit,
  sampleSpotPool,
} from "./live-paper/spot-market.mjs";

it("entry retry delays grow to five minutes, survive expiry, and clear after success", () => {
  let now = 1000;
  const retry = createAdmissionRetry(() => now),
    key = "pool-a:0.001";
  assert.equal(retry.get(key), null);
  for (const delay of [30000, 60000, 120000, 300000, 300000]) {
    const reason = `Rejected at ${now}`;
    assert.deepEqual(retry.reject(key, reason), { reason, nextRetryAt: now + delay });
    const view = retry.get(key);
    view.nextRetryAt = 0;
    assert.equal(retry.get(key).nextRetryAt, now + delay, "callers cannot mutate the retry");
    now += delay - 1;
    assert.equal(retry.get(key).reason, reason);
    now++;
    assert.equal(retry.get(key), null, "the exact retry deadline permits a new probe");
  }
  retry.clear(key);
  assert.deepEqual(retry.reject(key, "Retry after success"), {
    reason: "Retry after success",
    nextRetryAt: now + 30000,
  });
});

it("a rejected pool/capital cannot block another pool or a different size", () => {
  const retry = createAdmissionRetry(() => 1000);
  retry.reject("pool-a:0.001", "High costs");
  assert.equal(retry.get("pool-a:0.002"), null);
  assert.equal(retry.get("pool-b:0.001"), null);
  retry.reject("pool-b:0.001", "Blocked sale");
  retry.clear("pool-a:0.001");
  assert.equal(retry.get("pool-a:0.001"), null);
  assert.equal(retry.get("pool-b:0.001").reason, "Blocked sale");
});

it("only explicit admission codes and actual viem execution reverts are expected rejections", () => {
  const explicit = Object.assign(new Error("Cost exceeds limit"), { code: "PAPER_ENTRY_REJECTED" });
  for (const error of [
    explicit,
    new ContractFunctionRevertedError({ abi: [], functionName: "sell", message: "Sale blocked" }),
    new ExecutionRevertedError({ message: "execution reverted: sale blocked" }),
  ]) {
    assert.equal(isEntryRejection(error), true);
    assert.equal(isEntryRejection(new Error("Call failed", { cause: error })), true);
  }
  const timeout = new TimeoutError({ body: {}, url: "https://rpc.invalid" });
  for (const error of [
    timeout,
    new Error("Call failed", { cause: timeout }),
    new Error("execution reverted"),
    Object.assign(new Error("Unavailable"), { name: "ExecutionRevertedError" }),
    null,
  ])
    assert.equal(isEntryRejection(error), false);
  const circular = new Error("RPC error");
  circular.cause = circular;
  assert.equal(isEntryRejection(circular), false);
});

const token = "0x" + "c1".repeat(20),
  pool = {
    id: "0x" + "c2".repeat(20),
    other: token,
    dex: "uniswap-v2-robinhood",
    wethUsd: 2400,
  },
  snapshot = { block: "100", at: Date.now(), gasPrice: 1n },
  balanceSlot = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [EXIT_WALLET, 0n]),
  );
function clientWithProbe(probe) {
  return {
    readContract: async ({ functionName }) => {
      const values = {
        token0: CONTRACTS.weth,
        token1: token,
        getPair: pool.id,
        decimals: 18,
        getReserves: [parseEther("100"), parseEther("100000"), 0],
      };
      if (!(functionName in values)) throw new Error(`Unexpected ${functionName}`);
      return values[functionName];
    },
    getLogs: async () => [],
    getBytecode: async () => "0x60006000",
    call: async (args) => {
      if (args.to === token) {
        const change = args.stateOverride[0].stateDiff[0];
        const balance = change.slot === balanceSlot ? BigInt(change.value) : 0n;
        return { data: encodeAbiParameters([{ type: "uint256" }], [balance]) };
      }
      return probe(args);
    },
  };
}

it("numeric spot entry failures carry a typed rejection while diagnostic cost evidence remains available", async () => {
  for (const [recovered, bought] of [
    [parseEther("0.00096"), 1n],
    [parseEther("0.001"), 0n],
    [0n, 1n],
  ]) {
    const client = clientWithProbe(async () => ({
      data: encodeAbiParameters(
        Array.from({ length: 4 }, () => ({ type: "uint256" })),
        [recovered, bought, 1000n, 1000n],
      ),
    }));
    await assert.rejects(sampleSpotPool(client, pool, 0.001, snapshot.at, snapshot), (error) => {
      assert.equal(error.code, "PAPER_ENTRY_REJECTED");
      assert.equal(isEntryRejection(error), true);
      return true;
    });
    if (recovered > 0n && bought > 0n) {
      const measured = await sampleSpotPool(client, pool, 0.001, snapshot.at, snapshot, {
        diagnosticOnly: true,
      });
      assert.equal(measured.roundTripOk, false);
      assert.equal(measured.executionRecovery, 0.96);
    }
  }
});

it("isolated sale reverts are classifiable but RPC timeouts remain the original data failure", async () => {
  const revert = new ExecutionRevertedError({ message: "execution reverted: sale blocked" }),
    timeout = new TimeoutError({ body: {}, url: "https://rpc.invalid" });
  for (const error of [revert, timeout]) {
    const client = clientWithProbe(async () => {
      throw error;
    });
    await assert.rejects(quoteHeldExit(client, pool, "1000", snapshot), (caught) => {
      assert.equal(caught, error, "sale quote must preserve the original failure");
      assert.equal(isEntryRejection(caught), error === revert);
      return true;
    });
  }
});
