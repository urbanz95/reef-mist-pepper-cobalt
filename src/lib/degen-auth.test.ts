import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AUTH_WINDOW_MS,
  authFresh,
  degenAuthMessage,
  isAddress,
  isTxHash,
} from "./degen-auth.ts";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

describe("degen-auth", () => {
  it("validates addresses and tx hashes strictly", () => {
    assert.equal(isAddress(account.address), true);
    assert.equal(isAddress("0x123"), false);
    assert.equal(isAddress(`${account.address}00`), false);
    assert.equal(isAddress(undefined), false);
    assert.equal(isTxHash(`0x${"ab".repeat(32)}`), true);
    assert.equal(isTxHash(`0x${"ab".repeat(31)}`), false);
    assert.equal(isTxHash("0xzz"), false);
  });

  it("binds the signature to the action, wallet and timestamp", async () => {
    const ts = 1_700_000_000_000;
    const signature = await account.signMessage({
      message: degenAuthMessage("pause", account.address, ts),
    });
    const check = (action: "pause" | "resume", owner: string, t: number) =>
      verifyMessage({
        address: account.address,
        message: degenAuthMessage(action, owner, t),
        signature,
      });
    assert.equal(await check("pause", account.address, ts), true);
    // same wallet, different case: message is normalised
    assert.equal(await check("pause", account.address.toUpperCase().replace("0X", "0x"), ts), true);
    // a pause signature can never be replayed as resume, nor for another time/wallet
    assert.equal(await check("resume", account.address, ts), false);
    assert.equal(await check("pause", account.address, ts + 1), false);
    assert.equal(await check("pause", `0x${"22".repeat(20)}`, ts), false);
  });

  it("only accepts fresh signatures", () => {
    const now = 1_700_000_000_000;
    assert.equal(authFresh(now, now), true);
    assert.equal(authFresh(now - AUTH_WINDOW_MS, now), true);
    assert.equal(authFresh(now - AUTH_WINDOW_MS - 1, now), false);
    assert.equal(authFresh(now + 120_000, now), false);
    assert.equal(authFresh(Number.NaN, now), false);
  });
});
