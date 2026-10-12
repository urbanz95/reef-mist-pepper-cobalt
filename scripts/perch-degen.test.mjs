// Regression tests for contracts/PerchDegen.sol on a local EVM (ganache) with
// minimal mocks of WETH, ERC20, SwapRouter02 and the Uniswap v3 NPM.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ganache from "ganache";
import { createPublicClient, createWalletClient, custom, getAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const require = createRequire(import.meta.url);
const solc = require("solc");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const MOCKS = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockToken {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  address public blockedTo;          // honeypot: transfers to this address revert
  bool public useTransfer;           // WETH9 style (2300 gas) withdraw
  function setBlockedTo(address a) external { blockedTo = a; }
  function setUseTransfer(bool b) external { useTransfer = b; }
  function mint(address to, uint256 a) external { balanceOf[to] += a; }
  function fund() external payable {}
  function deposit() external payable { balanceOf[msg.sender] += msg.value; }
  function withdraw(uint256 w) external {
    require(balanceOf[msg.sender] >= w, "bal");
    balanceOf[msg.sender] -= w;
    if (useTransfer) { payable(msg.sender).transfer(w); }
    else { (bool ok, ) = msg.sender.call{value: w}(""); require(ok, "eth"); }
  }
  function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
  function _t(address f, address t, uint256 a) internal {
    require(t != blockedTo || blockedTo == address(0), "honeypot");
    require(balanceOf[f] >= a, "bal");
    balanceOf[f] -= a; balanceOf[t] += a;
  }
  function transfer(address t, uint256 a) external returns (bool) { _t(msg.sender, t, a); return true; }
  function transferFrom(address f, address t, uint256 a) external returns (bool) {
    require(allowance[f][msg.sender] >= a, "allow");
    allowance[f][msg.sender] -= a;
    _t(f, t, a); return true;
  }
}

contract MockRouter {
  struct P { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
  // 1:1 swap, output is minted out of thin air
  function exactInputSingle(P calldata p) external payable returns (uint256) {
    MockToken(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
    require(p.amountIn >= p.amountOutMinimum, "slippage");
    MockToken(p.tokenOut).mint(p.recipient, p.amountIn);
    return p.amountIn;
  }
}

contract MockNpm {
  struct Pos { address t0; address t1; uint128 liq; uint256 a0; uint256 a1; uint256 o0; uint256 o1; }
  struct MintP { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }
  struct DecP { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }
  struct ColP { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }
  mapping(uint256 => Pos) public pos;
  mapping(uint256 => address) public ownerOf;
  uint256 public next = 1;
  function mint(MintP calldata p) external payable returns (uint256 id, uint128 l, uint256 a, uint256 b) {
    MockToken(p.token0).transferFrom(msg.sender, address(this), p.amount0Desired);
    MockToken(p.token1).transferFrom(msg.sender, address(this), p.amount1Desired);
    id = next++;
    pos[id] = Pos(p.token0, p.token1, 1, p.amount0Desired, p.amount1Desired, 0, 0);
    ownerOf[id] = p.recipient;
    return (id, 1, p.amount0Desired, p.amount1Desired);
  }
  function positions(uint256 id) external view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128) {
    Pos memory s = pos[id];
    return (0, address(0), s.t0, s.t1, 3000, 0, 0, s.liq, 0, 0, uint128(s.o0), uint128(s.o1));
  }
  function decreaseLiquidity(DecP calldata p) external payable returns (uint256, uint256) {
    require(ownerOf[p.tokenId] == msg.sender, "owner");
    Pos storage s = pos[p.tokenId];
    s.o0 += s.a0; s.o1 += s.a1; s.a0 = 0; s.a1 = 0; s.liq = 0;
    return (s.o0, s.o1);
  }
  function collect(ColP calldata p) external payable returns (uint256, uint256) {
    require(ownerOf[p.tokenId] == msg.sender, "owner");
    Pos storage s = pos[p.tokenId];
    uint256 o0 = s.o0; uint256 o1 = s.o1; s.o0 = 0; s.o1 = 0;
    MockToken(s.t0).transfer(p.recipient, o0);
    MockToken(s.t1).transfer(p.recipient, o1);
    return (o0, o1);
  }
  function transferFrom(address from, address to, uint256 id) external {
    require(ownerOf[id] == from && msg.sender == from, "nft");
    ownerOf[id] = to;
  }
}
`;

function compile(name, src) {
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { [name]: { content: src } },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "shanghai",
          outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
        },
      }),
    ),
  );
  const errs = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  const res = {};
  for (const [cn, c] of Object.entries(out.contracts[name])) {
    res[cn] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
  }
  return res;
}

const mocks = compile("Mocks.sol", MOCKS);
const perch = compile("PerchDegen.sol", readFileSync(join(root, "contracts/PerchDegen.sol"), "utf8")).PerchDegen;

const ownerKey = `0x${"11".repeat(32)}`;
const opKey = `0x${"22".repeat(32)}`;
const strangerKey = `0x${"33".repeat(32)}`;
const bal = (v) => `0x${(v * 10n ** 18n).toString(16)}`;
const provider = ganache.provider({
  logging: { quiet: true },
  chain: { hardfork: "shanghai" },
  wallet: {
    accounts: [ownerKey, opKey, strangerKey].map((secretKey) => ({ secretKey, balance: bal(1000n) })),
  },
});
const chain = {
  id: 1337,
  name: "local",
  nativeCurrency: { name: "E", symbol: "E", decimals: 18 },
  rpcUrls: { default: { http: [] } },
};
const pub = createPublicClient({ chain, transport: custom(provider), pollingInterval: 20 });
const wallet = (key) =>
  createWalletClient({ account: privateKeyToAccount(key), chain, transport: custom(provider) });
const owner = wallet(ownerKey);
const operator = wallet(opKey);
const stranger = wallet(strangerKey);

after(async () => {
  await provider.disconnect();
});

/** A call "reverts" if it is rejected up front or mined with status "reverted". */
async function reverts(pending, msg) {
  let res;
  try {
    res = await pending;
  } catch {
    return;
  }
  const receipt = typeof res === "string" ? await pub.waitForTransactionReceipt({ hash: res }) : res;
  assert.equal(receipt.status, "reverted", msg);
}

async function deploy(client, c, args = [], value) {
  const hash = await client.deployContract({ abi: c.abi, bytecode: c.bytecode, args, value });
  const r = await pub.waitForTransactionReceipt({ hash });
  return getAddress(r.contractAddress);
}

async function setup({ wethUsesTransfer }) {
  const weth = await deploy(owner, mocks.MockToken);
  await owner.writeContract({ address: weth, abi: mocks.MockToken.abi, functionName: "fund", value: parseEther("50") });
  await owner.writeContract({ address: weth, abi: mocks.MockToken.abi, functionName: "setUseTransfer", args: [wethUsesTransfer] });
  const router = await deploy(owner, mocks.MockRouter);
  const npm = await deploy(owner, mocks.MockNpm);
  const vault = await deploy(owner, perch, [operator.account.address, weth, npm, router], parseEther("1"));
  const mkToken = async (honeypot = false) => {
    const t = await deploy(owner, mocks.MockToken);
    if (honeypot) {
      await owner.writeContract({ address: t, abi: mocks.MockToken.abi, functionName: "setBlockedTo", args: [router] });
    }
    return t;
  };
  const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
  const tokenBal = (t, a) => read(t, mocks.MockToken.abi, "balanceOf", [a]);
  const rebalance = (client, token, minOutExit, minOutEnter) =>
    client.writeContract({
      address: vault,
      abi: perch.abi,
      functionName: "rebalance",
      args: [token, weth, 3000, -887220, 887220, minOutExit, minOutEnter],
      gas: 5_000_000n,
    });
  const send = async (client, fn, args = []) => {
    const hash = await client.writeContract({ address: vault, abi: perch.abi, functionName: fn, args, gas: 5_000_000n });
    return pub.waitForTransactionReceipt({ hash });
  };
  return { weth, router, npm, vault, mkToken, tokenBal, read, rebalance, send };
}

describe("PerchDegen exit()", () => {
  for (const wethUsesTransfer of [true, false]) {
    it(`pays native ETH to the owner (WETH.withdraw via ${wethUsesTransfer ? "transfer" : "call"})`, async () => {
      const t = await setup({ wethUsesTransfer });
      const before = await pub.getBalance({ address: owner.account.address });
      const r = await t.send(owner, "exit");
      assert.equal(r.status, "success");
      const after = await pub.getBalance({ address: owner.account.address });
      const gas = r.gasUsed * r.effectiveGasPrice;
      // 1 ETH deposit minus the 0.001 ETH keeper stipend
      assert.equal(after - before + gas, parseEther("0.999"));
      assert.equal(await t.tokenBal(t.weth, t.vault), 0n);
      assert.equal(await pub.getBalance({ address: t.vault }), 0n);
    });
  }

  it("round-trips a position: rebalance in, exit out", async () => {
    const t = await setup({ wethUsesTransfer: false });
    const token = await t.mkToken();
    await pub.waitForTransactionReceipt({ hash: await t.rebalance(operator, token, 1n, 1n) });
    assert.equal(await t.read(t.vault, perch.abi, "tokenId"), 1n);
    const before = await pub.getBalance({ address: owner.account.address });
    const r = await t.send(owner, "exit");
    const after = await pub.getBalance({ address: owner.account.address });
    assert.equal(after - before + r.gasUsed * r.effectiveGasPrice, parseEther("0.999"));
    assert.equal(await t.read(t.vault, perch.abi, "tokenId"), 0n);
  });

  it("a honeypot token cannot trap the exit: ETH out, token handed over raw", async () => {
    const t = await setup({ wethUsesTransfer: false });
    const hp = await t.mkToken(true);
    await pub.waitForTransactionReceipt({ hash: await t.rebalance(operator, hp, 1n, 1n) });
    const before = await pub.getBalance({ address: owner.account.address });
    const r = await t.send(owner, "exit");
    assert.equal(r.status, "success");
    const after = await pub.getBalance({ address: owner.account.address });
    assert.equal(after - before + r.gasUsed * r.effectiveGasPrice, parseEther("0.4995"));
    assert.equal(await t.tokenBal(hp, owner.account.address), parseEther("0.4995"));
    assert.equal(await t.tokenBal(hp, t.vault), 0n);
  });

  it("exitNoSwap() returns ETH plus the raw pair token", async () => {
    const t = await setup({ wethUsesTransfer: false });
    const token = await t.mkToken();
    await pub.waitForTransactionReceipt({ hash: await t.rebalance(operator, token, 1n, 1n) });
    await t.send(owner, "exitNoSwap");
    assert.equal(await t.tokenBal(token, owner.account.address), parseEther("0.4995"));
  });
});

describe("PerchDegen access control and safety rails", () => {
  it("only the owner can exit, rescue or change the operator", async () => {
    const t = await setup({ wethUsesTransfer: false });
    for (const [fn, args] of [
      ["exit", []],
      ["exitNoSwap", []],
      ["rescueNft", []],
      ["rescueToken", [t.weth]],
      ["setOperator", [stranger.account.address]],
    ]) {
      await reverts(t.send(operator, fn, args), `${fn} must reject the operator`);
      await reverts(t.send(stranger, fn, args), `${fn} must reject strangers`);
    }
  });

  it("rebalance rejects a zero slippage floor", async () => {
    const t = await setup({ wethUsesTransfer: false });
    const token = await t.mkToken();
    await reverts(t.rebalance(operator, token, 1n, 0n), "minOutEnter = 0");
    await pub.waitForTransactionReceipt({ hash: await t.rebalance(operator, token, 1n, 1n) });
    // hopping away from a position with a pair-token balance also needs minOutExit > 0
    const next = await t.mkToken();
    await reverts(t.rebalance(operator, next, 0n, 1n), "minOutExit = 0");
    await pub.waitForTransactionReceipt({ hash: await t.rebalance(operator, next, 1n, 1n) });
  });

  it("rebalance rejects non-standard fee tiers and non-WETH pairs", async () => {
    const t = await setup({ wethUsesTransfer: false });
    const token = await t.mkToken();
    await reverts(
      operator.writeContract({
        address: t.vault, abi: perch.abi, functionName: "rebalance",
        args: [token, t.weth, 1234, -887220, 887220, 1n, 1n], gas: 5_000_000n,
      }),
      "fee tier 1234",
    );
    const other = await t.mkToken();
    await reverts(
      operator.writeContract({
        address: t.vault, abi: perch.abi, functionName: "rebalance",
        args: [token, other, 3000, -887220, 887220, 1n, 1n], gas: 5_000_000n,
      }),
      "non-WETH pair",
    );
  });

  it("rescueNft() hands the position NFT to the owner", async () => {
    const t = await setup({ wethUsesTransfer: false });
    const token = await t.mkToken();
    await pub.waitForTransactionReceipt({ hash: await t.rebalance(operator, token, 1n, 1n) });
    await t.send(owner, "rescueNft");
    assert.equal(await t.read(t.vault, perch.abi, "tokenId"), 0n);
    assert.equal(await t.read(t.npm, mocks.MockNpm.abi, "ownerOf", [1n]), owner.account.address);
  });

  it("rescueToken() sweeps stray tokens", async () => {
    const t = await setup({ wethUsesTransfer: false });
    const token = await t.mkToken();
    await owner.writeContract({ address: token, abi: mocks.MockToken.abi, functionName: "mint", args: [t.vault, 77n] });
    await t.send(owner, "rescueToken", [token]);
    assert.equal(await t.tokenBal(token, owner.account.address), 77n);
  });

  it("revoking the operator stops rebalances", async () => {
    const t = await setup({ wethUsesTransfer: false });
    const token = await t.mkToken();
    await t.send(owner, "setOperator", [stranger.account.address]);
    await reverts(t.rebalance(operator, token, 1n, 1n), "revoked operator");
  });
});
