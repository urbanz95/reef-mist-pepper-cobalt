import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  http,
  parseEther,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CONTRACTS, ROBINHOOD_CHAIN_ID, feeToPips } from "./chain";
import { DEGEN_ABI, DEGEN_BYTECODE } from "./degen-artifact";
import { canMintOnchain, isWethPair, WETH, type Pool } from "./pools";
import { rangeFromPreset, sortedTokens } from "./uniswap-lp";

export const OPERATOR_STIPEND = parseEther("0.001");
export const SLIPPAGE_BPS = 100n;

export const robinhoodChain = {
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
} as const;

const transport = http("https://rpc.mainnet.chain.robinhood.com");

export function publicClient() {
  return createPublicClient({ chain: robinhoodChain, transport });
}

export function degenChainOk(pool: Pool) {
  return canMintOnchain(pool) && isWethPair(pool);
}

export function encodeDeployDegen(operator: string) {
  return encodeDeployData({
    abi: DEGEN_ABI,
    bytecode: DEGEN_BYTECODE,
    args: [
      operator as `0x${string}`,
      CONTRACTS.weth,
      CONTRACTS.npm,
      CONTRACTS.swapRouter02,
    ],
  });
}

export function encodeExit() {
  return encodeFunctionData({ abi: DEGEN_ABI, functionName: "exit" });
}

export function encodeDeposit() {
  return encodeFunctionData({ abi: DEGEN_ABI, functionName: "deposit" });
}

export function deployValueWei(eth: number) {
  return parseEther(Math.max(eth, 0).toFixed(8)) + OPERATOR_STIPEND;
}

const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

function slip(amount: bigint) {
  if (amount === 0n) return 0n;
  const cut = (amount * SLIPPAGE_BPS) / 10000n;
  const min = amount - cut;
  return min > 0n ? min : 1n;
}

export async function quoteMinOut(args: {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: bigint;
}) {
  if (args.amountIn === 0n || args.tokenIn.toLowerCase() === args.tokenOut.toLowerCase()) {
    return 0n;
  }
  const client = publicClient();
  try {
    const { result } = await client.simulateContract({
      address: CONTRACTS.quoterV2,
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: args.tokenIn as `0x${string}`,
          tokenOut: args.tokenOut as `0x${string}`,
          amountIn: args.amountIn,
          fee: args.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return slip(result[0]);
  } catch {
    return 1n;
  }
}

function rebalanceCalldata(pool: Pool, minOutExit: bigint, minOutEnter: bigint) {
  const { token0, token1 } = sortedTokens(pool);
  const range = rangeFromPreset(pool.priceUsd || 1, "full", pool.feePct);
  return encodeFunctionData({
    abi: DEGEN_ABI,
    functionName: "rebalance",
    args: [
      token0.address as `0x${string}`,
      token1.address as `0x${string}`,
      feeToPips(pool.feePct),
      range.tickLower,
      range.tickUpper,
      minOutExit,
      minOutEnter,
    ],
  });
}

export async function readVault(vault: string) {
  const client = publicClient();
  const address = vault as `0x${string}`;
  const [owner, operator, tokenId, token0, token1, fee] = await Promise.all([
    client.readContract({ address, abi: DEGEN_ABI, functionName: "owner" }),
    client.readContract({ address, abi: DEGEN_ABI, functionName: "operator" }),
    client.readContract({ address, abi: DEGEN_ABI, functionName: "tokenId" }),
    client.readContract({ address, abi: DEGEN_ABI, functionName: "token0" }),
    client.readContract({ address, abi: DEGEN_ABI, functionName: "token1" }),
    client.readContract({ address, abi: DEGEN_ABI, functionName: "fee" }),
  ]);
  const wethBal = await client.readContract({
    address: CONTRACTS.weth,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
  return {
    owner: owner as string,
    operator: operator as string,
    tokenId: tokenId as bigint,
    token0: token0 as string,
    token1: token1 as string,
    fee: Number(fee),
    weth: wethBal as bigint,
    eth: Number(formatEther(wethBal as bigint)),
  };
}

export async function verifyVault(vault: string, owner: string, keeper: string) {
  const on = await readVault(vault);
  if (on.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("This vault does not belong to this wallet.");
  }
  if (on.operator.toLowerCase() !== keeper.toLowerCase()) {
    throw new Error("This vault operator is not the Perch keeper.");
  }
  return on;
}

export async function waitArmReceipt(hash: Hex) {
  const client = publicClient();
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The arm transaction reverted.");
  const vault = receipt.contractAddress;
  if (!vault) throw new Error("The transaction confirmed without creating a vault.");
  return { vault, from: receipt.from, hash };
}

export async function operatorRebalance(args: {
  operatorPk: Hex;
  vault: string;
  pool: Pool;
}) {
  if (!degenChainOk(args.pool)) {
    throw new Error("This pool is not a v3 ETH pair. The on-chain hunter only hops WETH pairs.");
  }
  const client = publicClient();
  const vault = args.vault as `0x${string}`;
  const state = await readVault(args.vault);
  const weth = CONTRACTS.weth;
  let minOutExit = 0n;
  const otherNow =
    state.token0 && state.token0.toLowerCase() !== weth.toLowerCase()
      ? state.token0
      : state.token1 && state.token1.toLowerCase() !== weth.toLowerCase()
        ? state.token1
        : null;
  if (otherNow && state.fee) {
    const bal = await client.readContract({
      address: otherNow as `0x${string}`,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    });
    const guess = (state.weth > 0n ? state.weth : parseEther("0.01")) / 2n;
    const amountIn = (bal as bigint) > 0n ? (bal as bigint) : guess;
    minOutExit = await quoteMinOut({
      tokenIn: otherNow,
      tokenOut: weth,
      fee: state.fee,
      amountIn,
    });
  }

  const { token0, token1 } = sortedTokens(args.pool);
  const otherNew =
    token0.address.toLowerCase() === weth.toLowerCase() ? token1.address : token0.address;
  const wethNow = await client.readContract({
    address: CONTRACTS.weth,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [vault],
  });
  const half = ((wethNow as bigint) > 0n ? (wethNow as bigint) : parseEther("0.02")) / 2n;
  const minOutEnter = await quoteMinOut({
    tokenIn: weth,
    tokenOut: otherNew,
    fee: feeToPips(args.pool.feePct),
    amountIn: half,
  });

  const account = privateKeyToAccount(args.operatorPk);
  const wallet = createWalletClient({
    account,
    chain: robinhoodChain,
    transport,
  });
  const hash = await wallet.sendTransaction({
    to: vault,
    data: rebalanceCalldata(args.pool, minOutExit, minOutEnter),
    chain: robinhoodChain,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The on-chain hop reverted.");
  return hash;
}

export { WETH };
