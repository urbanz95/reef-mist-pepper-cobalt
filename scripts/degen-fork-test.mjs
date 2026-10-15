// Explicitly local only. Start Anvil with a Robinhood Chain fork; this script
// refuses every non-loopback URL and every chain ID other than 31337.
import assert from "node:assert/strict";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeDeployData,
  parseEther,
  erc20Abi,
  zeroAddress,
  formatEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEGEN_ABI, DEGEN_BYTECODE } from "../src/lib/degen-artifact.ts";
import { PROBE_ABI, PROBE_BYTECODE } from "../src/lib/degen-probe-artifact.ts";
async function main() {
  const endpoint = new URL(process.env.LOCAL_FORK_URL || "http://127.0.0.1:8545");
  if (endpoint.hostname !== "127.0.0.1" || endpoint.protocol !== "http:")
    throw new Error("Local fork only");
  const chain = {
    id: 31337,
    name: "Local Robinhood fork",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [endpoint.href] } },
  };
  const transport = http(endpoint.href, { timeout: 120000, retryCount: 0 });
  const pub = createPublicClient({ chain, transport, pollingInterval: 20 });
  assert.equal(await pub.getChainId(), 31337, "Refusing real chain");
  const account = privateKeyToAccount("0x" + "11".repeat(32));
  const operator = privateKeyToAccount("0x" + "22".repeat(32));
  const owner = createWalletClient({ account, chain, transport });
  const keeper = createWalletClient({ account: operator, chain, transport });
  await pub.request({
    method: "anvil_setBalance",
    params: [account.address, "0x" + parseEther("100").toString(16)],
  });
  await pub.request({
    method: "anvil_setBalance",
    params: [operator.address, "0x" + parseEther("100").toString(16)],
  });
  const c = {
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    npm: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
    router: "0xCaf681a66D020601342297493863E78C959E5cb2",
    factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  };
  const factoryAbi = [
    {
      type: "function",
      name: "getPool",
      stateMutability: "view",
      inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }],
      outputs: [{ type: "address" }],
    },
  ];
  let pool, fee;
  for (const tier of [500, 3000, 100, 10000]) {
    const address = await pub.readContract({
      address: c.factory,
      abi: factoryAbi,
      functionName: "getPool",
      args: [c.weth, c.usdg, tier],
    });
    if (address !== zeroAddress) {
      pool = address;
      fee = tier;
      break;
    }
  }
  assert.ok(pool, "No WETH/USDG pool exists");
  const spacing = { 100: 1, 500: 10, 3000: 60, 10000: 200 }[fee];
  const upper = Math.floor(887272 / spacing) * spacing,
    lower = -upper;
  const deposit = parseEther(".00045"),
    stipend = parseEther(".00005");
  const block = await pub.getBlockNumber();
  console.log(
    JSON.stringify({
      test: "local fork",
      block: String(block),
      pool,
      fee,
      syntheticDepositEth: formatEther(deposit),
    }),
  );
  const probe = encodeDeployData({
    abi: PROBE_ABI,
    bytecode: PROBE_BYTECODE,
    args: [c.weth, c.npm, c.router, c.usdg, fee, lower, upper],
  });
  const roundTrip = await pub.call({
    account: account.address,
    data: probe,
    value: deposit + stipend,
    gas: 12000000n,
  });
  assert.ok(roundTrip.data);
  assert.ok(BigInt(roundTrip.data) >= (deposit * 97n) / 100n);
  console.log(
    "Real router/NPM atomic buy → mint → remove → sell probe passed; recovered",
    formatEther(BigInt(roundTrip.data)),
    "synthetic ETH",
  );
  const hash = await owner.deployContract({
    abi: DEGEN_ABI,
    bytecode: DEGEN_BYTECODE,
    args: [operator.address, c.weth, c.npm, c.router, [c.usdg]],
    value: deposit + stipend,
  });
  const deployment = await pub.waitForTransactionReceipt({ hash });
  assert.equal(deployment.status, "success");
  const vault = deployment.contractAddress;
  assert.ok(vault);
  const enter = await keeper.writeContract({
    address: vault,
    abi: DEGEN_ABI,
    functionName: "rebalance",
    args: [c.weth, c.usdg, fee, lower, upper, 0n, 1n],
    gas: 3000000n,
  });
  assert.equal((await pub.waitForTransactionReceipt({ hash: enter })).status, "success");
  assert.ok(
    (await pub.readContract({ address: vault, abi: DEGEN_ABI, functionName: "tokenId" })) > 0n,
  );
  const deadline = (await pub.getBlock()).timestamp + 120n;
  const exit = await keeper.writeContract({
    address: vault,
    abi: DEGEN_ABI,
    functionName: "exitToWeth",
    args: [1n, (deposit * 97n) / 100n, deadline],
    gas: 3000000n,
  });
  assert.equal((await pub.waitForTransactionReceipt({ hash: exit })).status, "success");
  assert.equal(
    await pub.readContract({ address: vault, abi: DEGEN_ABI, functionName: "tokenId" }),
    0n,
  );
  const recovered = await pub.readContract({
    address: c.weth,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [vault],
  });
  assert.ok(recovered >= (deposit * 97n) / 100n);
  assert.equal(
    await pub.readContract({ address: vault, abi: DEGEN_ABI, functionName: "operator" }),
    zeroAddress,
  );
  const withdraw = await owner.writeContract({
    address: vault,
    abi: DEGEN_ABI,
    functionName: "exitNoSwap",
    gas: 500000n,
  });
  assert.equal((await pub.waitForTransactionReceipt({ hash: withdraw })).status, "success");
  assert.equal(
    await pub.readContract({
      address: c.weth,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    }),
    0n,
  );
  console.log(
    "PASS: separate transactions deployed, entered, exited to vault WETH, revoked operator and withdrew to owner. No real funds used.",
  );
}
main().catch((error) => {
  console.error(error.shortMessage ?? error.message);
  if (error.details) console.error(error.details.slice(0, 500));
  process.exitCode = 1;
});
