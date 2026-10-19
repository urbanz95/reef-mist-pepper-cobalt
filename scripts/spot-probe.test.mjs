// Local EVM only. Keys are fixed Ganache fixtures; no real wallet or RPC is used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, it } from "node:test";
import ganache from "ganache";
import {
  createPublicClient,
  createWalletClient,
  custom,
  parseEther,
  encodeDeployData,
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  toHex,
  zeroAddress,
  getContractAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  heldBalanceOverride,
  PROBE_ACCOUNT,
  EXIT_WRAPPER,
  EXIT_WALLET,
} from "./live-paper/spot-market.mjs";
const solc = createRequire(import.meta.url)("solc");
const mocks = `pragma solidity ^0.8.24;
contract Token {
 mapping(address=>uint256) public balanceOf;
 mapping(address=>mapping(address=>uint256)) public allowance;
 bool public blocked;
 function setBlocked(bool b) external {blocked=b;}
 function mint(address to,uint256 n) external {balanceOf[to]+=n;}
 function approve(address to,uint256 n) external returns(bool){allowance[msg.sender][to]=n;return true;}
 function transfer(address to,uint256 n) external returns(bool){require(balanceOf[msg.sender]>=n);balanceOf[msg.sender]-=n;balanceOf[to]+=n;return true;}
 function transferFrom(address from,address to,uint256 n) external returns(bool){require(!blocked,"sale blocked");require(balanceOf[from]>=n&&allowance[from][msg.sender]>=n);balanceOf[from]-=n;allowance[from][msg.sender]-=n;balanceOf[to]+=n;return true;}
}
contract V2Router {
 Token public token;
 constructor(Token t)payable{token=t;}
 function swapExactETHForTokens(uint256 min,address[] calldata,address to,uint256)external payable returns(uint256[] memory r){
  uint256 out=msg.value*token.balanceOf(address(this))/address(this).balance;
  require(out>=min);token.transfer(to,out);r=new uint256[](2);r[0]=msg.value;r[1]=out;
 }
 function swapExactTokensForETH(uint256 n,uint256 min,address[] calldata,address to,uint256)external returns(uint256[] memory r){
  uint256 beforeBal=token.balanceOf(address(this));token.transferFrom(msg.sender,address(this),n);
  uint256 out=n*address(this).balance/(beforeBal+n);require(out>=min,"insufficient output");
  (bool ok,)=to.call{value:out}("");require(ok);r=new uint256[](2);r[0]=n;r[1]=out;
 }
}
contract Curve {
 Token public token; uint8 public mode; bool public ready;
 constructor(Token t)payable{token=t;}
 function setMode(uint8 m)external{mode=m;ready=false;}
 function buy(uint256 n,uint256,address to)external payable returns(uint256 out){
  require(msg.value==n && mode!=3,"closed");
  if(mode==1){n/=2;(bool ok,)=to.call{value:msg.value-n}("");require(ok);}
  out=n*99/100*1000;token.mint(to,out);if(mode==2)ready=true;
 }
 function sell(uint256 n,uint256,address to)external returns(uint256 out){
  require(mode!=3 && !ready,"curve closed");token.transferFrom(msg.sender,address(this),n);
  out=n/1000*99/100;(bool ok,)=to.call{value:out}("");require(ok);
 }
}
`;
const out = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: {
        "Probe.sol": {
          content: readFileSync(
            new URL("../contracts/PerchSpotPaperProbe.sol", import.meta.url),
            "utf8",
          ),
        },
        "Mocks.sol": { content: mocks },
      },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        evmVersion: "shanghai",
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      },
    }),
  ),
);
assert.equal(
  out.errors?.some((e) => e.severity === "error") ?? false,
  false,
  JSON.stringify(out.errors),
);
const art = (file, name) => ({
  abi: out.contracts[file][name].abi,
  bytecode: "0x" + out.contracts[file][name].evm.bytecode.object,
});
const key = "0x" + "11".repeat(32),
  account = privateKeyToAccount(key),
  provider = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai" },
    wallet: { accounts: [{ secretKey: key, balance: toHex(parseEther("100")) }] },
  });
const chain = {
  id: 1337,
  name: "local",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
};
const client = createPublicClient({ chain, transport: custom(provider), pollingInterval: 10 }),
  wallet = createWalletClient({ chain, account, transport: custom(provider) });
const deploy = async (file, name, args = [], value = 0n) => {
  const hash = await wallet.deployContract({ ...art(file, name), args, value });
  return (await client.waitForTransactionReceipt({ hash })).contractAddress;
};
const write = async (address, name, args) => {
  const hash = await wallet.writeContract({
    address,
    abi: art("Mocks.sol", "Token").abi,
    functionName: name,
    args,
  });
  await client.waitForTransactionReceipt({ hash });
};
after(async () => provider.disconnect());
it("sale-only constructor values the held amount without a fresh buy refilling a drained pool, and rolls back all state", async () => {
  const token = await deploy("Mocks.sol", "Token"),
    weth = await deploy("Mocks.sol", "Token");
  const router = await deploy("Mocks.sol", "V2Router", [token], 1000000000000n);
  await write(token, "mint", [router, parseEther("1000000")]);
  const poolKey = {
      currency0: weth,
      currency1: token,
      fee: 3000,
      tickSpacing: 0,
      hooks: zeroAddress,
    },
    args = [weth, token, router, 2, poolKey];
  const base = {
    account: PROBE_ACCOUNT,
    gas: 12000000n,
    stateOverride: [{ address: PROBE_ACCOUNT, nonce: 0, balance: parseEther("100") }],
  };
  const roundtrip = await client.call({
    ...base,
    data: encodeDeployData({ ...art("Probe.sol", "PerchSpotPaperProbe"), args }),
    value: parseEther(".0019"),
  });
  const [recovered, bought] = decodeAbiParameters(
    Array.from({ length: 4 }, () => ({ type: "uint256" })),
    roundtrip.data,
  );
  assert.ok(
    Number(recovered) / Number(parseEther(".0019")) > 0.99,
    "new buy/sell misleadingly passes",
  );
  const override = await heldBalanceOverride(
    client,
    token,
    String(bought),
    String(await client.getBlockNumber({ cacheTime: 0 })),
  );
  // Ganache increments the synthetic creator nonce before deriving a top-level
  // creation eth_call address. The target RPC uses nonce 0, verified separately
  // on V2/V3/V4. Seed the mock wallet at Ganache's nonce-1 address as well.
  const localWrapper = getContractAddress({ from: PROBE_ACCOUNT, nonce: 1n });
  const localWallet = getContractAddress({ from: localWrapper, nonce: 1n });
  override.stateDiff.push({
    slot: keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [localWallet, 0n]),
    ),
    value: toHex(bought, { size: 32 }),
  });
  const result = await client.call({
    ...base,
    data: encodeDeployData({ ...art("Probe.sol", "PerchSpotExitProbe"), args: [...args, bought] }),
    stateOverride: [...base.stateOverride, override],
  });
  const [proceeds, gas] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    result.data,
  );
  assert.ok(proceeds < 1000000000000n);
  assert.ok(gas > 0n);
  assert.ok(proceeds * 1000n < recovered);
  assert.equal(await client.getBalance({ address: router }), 1000000000000n);
  assert.equal(
    await client.readContract({
      address: token,
      abi: art("Mocks.sol", "Token").abi,
      functionName: "balanceOf",
      args: [EXIT_WALLET],
    }),
    0n,
  );
  assert.equal(await client.getBytecode({ address: EXIT_WRAPPER }), undefined);
  assert.equal(await client.getBytecode({ address: EXIT_WALLET }), undefined);
  assert.equal(await client.getBytecode({ address: localWrapper }), undefined);
  assert.equal(await client.getBytecode({ address: localWallet }), undefined);
  await write(token, "setBlocked", [true]);
  await assert.rejects(
    client.call({
      ...base,
      data: encodeDeployData({
        ...art("Probe.sol", "PerchSpotExitProbe"),
        args: [...args, bought],
      }),
      stateOverride: [...base.stateOverride, override],
    }),
  );
});
it("held balance overrides require exact balance proof and refuse unknown accounting", async () => {
  const fake = {
    getBytecode: async () => "0x60006000",
    call: async () => ({ data: toHex(0n, { size: 32 }) }),
  };
  await assert.rejects(
    heldBalanceOverride(fake, "0x" + "12".repeat(20), "1", "1"),
    /cannot be proved/,
  );
});

it("Pons curve eth_call measures fees and sells the exact held amount; partial fills and graduation closure cannot become fake entries", async () => {
  const token = await deploy("Mocks.sol", "Token"),
    weth = await deploy("Mocks.sol", "Token"),
    curve = await deploy("Mocks.sol", "Curve", [token], parseEther("1"));
  const args = [
    weth,
    token,
    curve,
    5,
    { currency0: zeroAddress, currency1: token, fee: 0, tickSpacing: 0, hooks: zeroAddress },
  ];
  const base = {
    account: PROBE_ACCOUNT,
    gas: 12000000n,
    stateOverride: [{ address: PROBE_ACCOUNT, nonce: 0, balance: parseEther("100") }],
  };
  const buy = () =>
    client.call({
      ...base,
      data: encodeDeployData({ ...art("Probe.sol", "PerchSpotPaperProbe"), args }),
      value: parseEther(".0019"),
    });
  const result = await buy(),
    [recovered, bought] = decodeAbiParameters(
      Array.from({ length: 4 }, () => ({ type: "uint256" })),
      result.data,
    );
  assert.equal(recovered, (parseEther(".0019") * 9801n) / 10000n);
  assert.ok(bought > 0n);
  const override = await heldBalanceOverride(
    client,
    token,
    String(bought),
    String(await client.getBlockNumber({ cacheTime: 0 })),
  );
  const localWrapper = getContractAddress({ from: PROBE_ACCOUNT, nonce: 1n }),
    localWallet = getContractAddress({ from: localWrapper, nonce: 1n });
  override.stateDiff.push({
    slot: keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [localWallet, 0n]),
    ),
    value: toHex(bought, { size: 32 }),
  });
  const exit = () =>
    client.call({
      ...base,
      data: encodeDeployData({
        ...art("Probe.sol", "PerchSpotExitProbe"),
        args: [...args, bought],
      }),
      stateOverride: [...base.stateOverride, override],
    });
  const sale = await exit(),
    [received] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], sale.data);
  assert.equal(received, recovered);
  for (const mode of [1, 2]) {
    const hash = await wallet.writeContract({
      address: curve,
      abi: art("Mocks.sol", "Curve").abi,
      functionName: "setMode",
      args: [mode],
    });
    await client.waitForTransactionReceipt({ hash });
    await assert.rejects(buy());
  }
  const hash = await wallet.writeContract({
    address: curve,
    abi: art("Mocks.sol", "Curve").abi,
    functionName: "setMode",
    args: [3],
  });
  await client.waitForTransactionReceipt({ hash });
  await assert.rejects(exit());
  assert.equal(await client.getBalance({ address: curve }), parseEther("1"));
});
