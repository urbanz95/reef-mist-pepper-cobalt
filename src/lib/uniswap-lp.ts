import { encodeFunctionData, erc20Abi, parseUnits } from "viem";
import { CONTRACTS, FEE_TICK_SPACING, feeToPips } from "./chain";
import type { Pool } from "./pools";

export const NPM_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "positions",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "nonce", type: "uint96" },
      { name: "operator", type: "address" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0", type: "uint128" },
      { name: "tokensOwed1", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "decreaseLiquidity",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "liquidity", type: "uint128" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "collect",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "amount0Max", type: "uint128" },
          { name: "amount1Max", type: "uint128" },
        ],
      },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
] as const;

export const WETH_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
] as const;

export const SWAP_ROUTER_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export function priceToTick(price: number) {
  if (price <= 0) return 0;
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

export function nearestUsableTick(tick: number, spacing: number) {
  return Math.round(tick / spacing) * spacing;
}

export function tickSpacingForFee(feePct: number) {
  const pips = feeToPips(feePct);
  return FEE_TICK_SPACING[pips] ?? 60;
}

export type RangePreset = "full" | 2 | 5 | 10 | 25 | 50;

export function rangeFromPreset(price: number, preset: RangePreset, feePct: number) {
  const spacing = tickSpacingForFee(feePct);
  if (preset === "full") {
    const min = nearestUsableTick(-887220, spacing);
    const max = nearestUsableTick(887220, spacing);
    return {
      tickLower: min,
      tickUpper: max,
      pMin: 0,
      pMax: Infinity,
    };
  }
  const pMin = price * (1 - preset / 100);
  const pMax = price * (1 + preset / 100);
  let tickLower = nearestUsableTick(priceToTick(pMin), spacing);
  let tickUpper = nearestUsableTick(priceToTick(pMax), spacing);
  if (tickLower >= tickUpper) tickUpper = tickLower + spacing;
  return { tickLower, tickUpper, pMin, pMax };
}

/**
 * Approximate Uniswap v3 in-range split: as price sits higher in the
 * range, the position holds more of the quote token.
 */
export function splitDeposit(usd: number, price: number, pMin: number, pMax: number) {
  if (!usd || !price) return { amountA: 0, amountB: 0, usdA: 0, usdB: 0 };
  let shareB = 0.5;
  if (Number.isFinite(pMin) && Number.isFinite(pMax) && pMax > pMin && pMin > 0) {
    const t =
      (Math.log(price) - Math.log(pMin)) / (Math.log(pMax) - Math.log(pMin));
    shareB = Math.min(0.98, Math.max(0.02, t));
  }
  const usdB = usd * shareB;
  const usdA = usd - usdB;
  return { amountA: usdA / price, amountB: usdB, usdA, usdB };
}

export function sortedTokens(pool: Pool) {
  const a = pool.tokenA.address.toLowerCase();
  const b = pool.tokenB.address.toLowerCase();
  const flip = a > b;
  return {
    token0: flip ? pool.tokenB : pool.tokenA,
    token1: flip ? pool.tokenA : pool.tokenB,
    flip,
  };
}

export function encodeApprove(spender: string, amount: bigint) {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender as `0x${string}`, amount],
  });
}

export function encodeBalanceOf(owner: string) {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner as `0x${string}`],
  });
}

export function encodeAllowance(owner: string, spender: string) {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner as `0x${string}`, spender as `0x${string}`],
  });
}

export function encodeWrapEth() {
  return encodeFunctionData({ abi: WETH_ABI, functionName: "deposit" });
}

export function encodeSwapExact(args: {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  amountIn: bigint;
  amountOutMin?: bigint;
}) {
  return encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: args.tokenIn as `0x${string}`,
        tokenOut: args.tokenOut as `0x${string}`,
        fee: args.fee,
        recipient: args.recipient as `0x${string}`,
        amountIn: args.amountIn,
        amountOutMinimum: args.amountOutMin ?? 0n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

export function encodeMint(args: {
  pool: Pool;
  tickLower: number;
  tickUpper: number;
  amountA: number;
  amountB: number;
  recipient: string;
  slippageBps?: number;
}) {
  const { token0, token1, flip } = sortedTokens(args.pool);
  const amount0Human = flip ? args.amountB : args.amountA;
  const amount1Human = flip ? args.amountA : args.amountB;
  const amount0 = parseUnits(trimAmount(amount0Human, token0.decimals), token0.decimals);
  const amount1 = parseUnits(trimAmount(amount1Human, token1.decimals), token1.decimals);
  return encodeMintWei({
    pool: args.pool,
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
    amount0,
    amount1,
    recipient: args.recipient,
    slippageBps: args.slippageBps,
  });
}

export function encodeMintWei(args: {
  pool: Pool;
  tickLower: number;
  tickUpper: number;
  amount0: bigint;
  amount1: bigint;
  recipient: string;
  slippageBps?: number;
}) {
  const { token0, token1 } = sortedTokens(args.pool);
  const slip = args.slippageBps ?? 100;
  const amount0Min = (args.amount0 * BigInt(10_000 - slip)) / 10_000n;
  const amount1Min = (args.amount1 * BigInt(10_000 - slip)) / 10_000n;
  const data = encodeFunctionData({
    abi: NPM_ABI,
    functionName: "mint",
    args: [
      {
        token0: token0.address as `0x${string}`,
        token1: token1.address as `0x${string}`,
        fee: feeToPips(args.pool.feePct),
        tickLower: args.tickLower,
        tickUpper: args.tickUpper,
        amount0Desired: args.amount0,
        amount1Desired: args.amount1,
        amount0Min,
        amount1Min,
        recipient: args.recipient as `0x${string}`,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 20 * 60),
      },
    ],
  });
  return {
    to: CONTRACTS.npm,
    data,
    token0,
    token1,
    amount0: args.amount0,
    amount1: args.amount1,
  };
}

export function encodePositions(tokenId: bigint) {
  return encodeFunctionData({
    abi: NPM_ABI,
    functionName: "positions",
    args: [tokenId],
  });
}

export function encodeDecrease(tokenId: bigint, liquidity: bigint) {
  return encodeFunctionData({
    abi: NPM_ABI,
    functionName: "decreaseLiquidity",
    args: [
      {
        tokenId,
        liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 20 * 60),
      },
    ],
  });
}

export function encodeCollect(tokenId: bigint, recipient: string) {
  const max = (1n << 128n) - 1n;
  return encodeFunctionData({
    abi: NPM_ABI,
    functionName: "collect",
    args: [
      {
        tokenId,
        recipient: recipient as `0x${string}`,
        amount0Max: max,
        amount1Max: max,
      },
    ],
  });
}

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function tokenIdFromLogs(
  logs: { topics?: string[]; address?: string }[] | undefined,
) {
  if (!logs?.length) return null;
  const npm = CONTRACTS.npm.toLowerCase();
  for (const log of logs) {
    const topics = log.topics ?? [];
    if (topics.length < 4) continue;
    if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.address && log.address.toLowerCase() !== npm) continue;
    try {
      return BigInt(topics[3] as string);
    } catch {
      continue;
    }
  }
  return null;
}

function trimAmount(n: number, decimals: number) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const d = Math.min(decimals, 8);
  return n.toFixed(d);
}

export { CONTRACTS };
