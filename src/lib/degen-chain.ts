import {
  createPublicClient,
  keccak256,
  createWalletClient,
  encodeDeployData,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  http,
  parseEther,
  zeroAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CONTRACTS, ROBINHOOD_CHAIN_ID, feeToPips } from "./chain";
import { PROBE_ABI, PROBE_BYTECODE } from "./degen-probe-artifact";
import { DEGEN_ABI, DEGEN_BYTECODE } from "./degen-artifact";
import { canMintOnchain, isWethPair, WETH, type Pool } from "./pools";
import { rangeFromPreset, sortedTokens } from "./uniswap-lp";
import { OPERATOR_STIPEND_ETH } from "./degen-amounts";

export const OPERATOR_STIPEND = parseEther(OPERATOR_STIPEND_ETH.toFixed(8));
export const SLIPPAGE_BPS = 100n;
/** Must match PerchDegen.MAX_DEPOSIT (the contract is what actually enforces it). */
export const MAX_ARM_ETH = 0.5;

export const robinhoodChain = {
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
} as const;

const transport = http("https://rpc.mainnet.chain.robinhood.com", { timeout: 8000, retryCount: 0 });

export function publicClient() {
  return createPublicClient({ chain: robinhoodChain, transport });
}

export function degenChainOk(pool: Pool) {
  return canMintOnchain(pool) && isWethPair(pool);
}

export function encodeDeployDegen(operator: string, tokens: string[] = []) {
  return encodeDeployData({
    abi: DEGEN_ABI,
    bytecode: DEGEN_BYTECODE,
    args: [
      operator as `0x${string}`,
      CONTRACTS.weth,
      CONTRACTS.npm,
      CONTRACTS.swapRouter02,
      tokens as `0x${string}`[],
    ],
  });
}

export function encodeExit() {
  return encodeFunctionData({ abi: DEGEN_ABI, functionName: "exitNoSwap" });
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

const NPM_ABI = [
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
] as const;

export class VaultEmptyError extends Error {
  constructor() {
    super("The vault is empty (the owner already exited).");
    this.name = "VaultEmptyError";
  }
}

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
  // Fail closed: no quote means no hop. The vault also rejects a zero floor.
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
  if (result[0] === 0n) throw new Error("Quoter returned 0: pool has no usable liquidity.");
  return slip(result[0]);
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
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 40_000,
  });
  if (receipt.status !== "success") throw new Error("The arm transaction reverted.");
  const vault = receipt.contractAddress;
  if (!vault) throw new Error("The transaction confirmed without creating a vault.");
  const tx = await client.getTransaction({ hash });
  return { vault, from: receipt.from, hash, input: tx.input, to: tx.to };
}

/**
 * What the vault will hold once its current position is closed, estimated
 * conservatively (fees owed are included, anything unknown counts as 0). Slippage
 * floors are quoted on these amounts, so a real result can only be better.
 */
async function estimateUnwind(vault: `0x${string}`, state: Awaited<ReturnType<typeof readVault>>) {
  const client = publicClient();
  const weth = CONTRACTS.weth.toLowerCase();
  let wethAmount = state.weth;
  let otherAmount = 0n;
  const otherToken =
    state.token0 && state.token0.toLowerCase() !== weth && state.token0 !== zeroAddress
      ? (state.token0 as `0x${string}`)
      : state.token1 && state.token1.toLowerCase() !== weth && state.token1 !== zeroAddress
        ? (state.token1 as `0x${string}`)
        : null;
  if (otherToken) {
    otherAmount = (await client.readContract({
      address: otherToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    })) as bigint;
  }
  if (state.tokenId > 0n) {
    const pos = await client.readContract({
      address: CONTRACTS.npm,
      abi: NPM_ABI,
      functionName: "positions",
      args: [state.tokenId],
    });
    const [, , p0, p1, , , , liquidity, , , owed0, owed1] = pos;
    let a0 = owed0;
    let a1 = owed1;
    if (liquidity > 0n) {
      // Dry-run the exact call the vault makes, as the vault (it owns the NFT).
      const sim = await client.simulateContract({
        account: vault,
        address: CONTRACTS.npm,
        abi: NPM_ABI,
        functionName: "decreaseLiquidity",
        args: [
          {
            tokenId: state.tokenId,
            liquidity,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
          },
        ],
      });
      a0 += sim.result[0];
      a1 += sim.result[1];
    }
    for (const [token, amount] of [
      [p0, a0],
      [p1, a1],
    ] as const) {
      if (token.toLowerCase() === weth) wethAmount += amount;
      else otherAmount += amount;
    }
  }
  return { wethAmount, otherAmount, otherToken };
}

export async function prepareRebalance(args: {
  operator: `0x${string}`;
  vault: string;
  pool: Pool;
}) {
  if (!degenChainOk(args.pool)) {
    throw new Error("This pool is not a v3 ETH pair. The on-chain hunter only hops WETH pairs.");
  }
  const client = publicClient();
  const vault = args.vault as `0x${string}`;
  const weth = CONTRACTS.weth;
  const state = await readVault(args.vault);
  const { wethAmount, otherAmount, otherToken } = await estimateUnwind(vault, state);
  if (wethAmount === 0n && otherAmount === 0n) throw new VaultEmptyError();

  // Floor for swapping the old pair token back to WETH.
  let minOutExit = 0n;
  let wethAfterExit = wethAmount;
  if (otherToken && otherAmount > 0n) {
    minOutExit = await quoteMinOut({
      tokenIn: otherToken,
      tokenOut: weth,
      fee: state.fee || 3000,
      amountIn: otherAmount,
    });
    wethAfterExit += minOutExit;
  }
  if (wethAfterExit === 0n) throw new VaultEmptyError();

  // Floor for the half-WETH swap into the new pair token.
  const { token0, token1 } = sortedTokens(args.pool);
  const otherNew =
    token0.address.toLowerCase() === weth.toLowerCase() ? token1.address : token0.address;
  const minOutEnter = await quoteMinOut({
    tokenIn: weth,
    tokenOut: otherNew,
    fee: feeToPips(args.pool.feePct),
    amountIn: wethAfterExit / 2n,
  });

  const data = rebalanceCalldata(args.pool, minOutExit, minOutEnter);
  await client.call({ account: args.operator, to: vault, data });
  const gas = await client.estimateGas({ account: args.operator, to: vault, data });
  const gasPrice = await client.getGasPrice();
  return {
    data,
    gas: (gas * 12n) / 10n,
    gasCostEth: Number(formatEther((gas * gasPrice * 15n) / 10n)),
  };
}

export async function vaultVersion(vault: string) {
  return publicClient()
    .readContract({ address: vault as Hex, abi: DEGEN_ABI, functionName: "VERSION" })
    .catch(() => 1n);
}

/** Conservative executable exit quote: includes LP principal and already owed fees.
 * Newly accrued fees may be understated, never presented as guaranteed proceeds. */
export async function valueVault(vault: string) {
  const state = await readVault(vault);
  const unwind = await estimateUnwind(vault as Hex, state);
  const minOut =
    unwind.otherToken && unwind.otherAmount > 0n
      ? await quoteMinOut({
          tokenIn: unwind.otherToken,
          tokenOut: CONTRACTS.weth,
          fee: state.fee,
          amountIn: unwind.otherAmount,
        })
      : 0n;
  const minTotal = unwind.wethAmount + minOut;
  return { state, minOut, minTotal, valueEth: Number(formatEther(minTotal)) };
}

export async function prepareExit(vault: string, operator = false) {
  if ((await vaultVersion(vault)) !== 2n)
    throw new Error("Legacy vault: use the raw-token withdrawal");
  const quote = await valueVault(vault);
  if (quote.minTotal === 0n) throw new VaultEmptyError();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
  const data = encodeFunctionData({
    abi: DEGEN_ABI,
    functionName: operator ? "exitToWeth" : "exitProtected",
    args: [quote.minOut, quote.minTotal, deadline],
  });
  const account = (operator ? quote.state.operator : quote.state.owner) as Hex;
  await publicClient().call({ account, to: vault as Hex, data });
  const gas = await publicClient().estimateGas({ account, to: vault as Hex, data });
  return {
    data,
    gas: (gas * 12n) / 10n,
    minimumEth: quote.valueEth,
    expiresAt: Number(deadline) * 1000,
  };
}

export async function verifyPool(pool: Pool) {
  if (!degenChainOk(pool)) throw new Error("Only v3 WETH pairs supported");
  const result = await publicClient().readContract({
    address: CONTRACTS.v3Factory,
    abi: [
      {
        type: "function",
        name: "getPool",
        stateMutability: "view",
        inputs: [
          { type: "address", name: "a" },
          { type: "address", name: "b" },
          { type: "uint24", name: "fee" },
        ],
        outputs: [{ type: "address" }],
      },
    ] as const,
    functionName: "getPool",
    args: [pool.tokenA.address as Hex, pool.tokenB.address as Hex, feeToPips(pool.feePct)],
  });
  if (result.toLowerCase() !== pool.id.toLowerCase() || result === zeroAddress)
    throw new Error("Pool factory mismatch");
}

/** No transaction is sent. Uses synthetic balance only inside eth_call. */
export async function probeRoundTrip(pool: Pool, amount: bigint) {
  await verifyPool(pool);
  const token =
    pool.tokenA.address.toLowerCase() === CONTRACTS.weth.toLowerCase()
      ? pool.tokenB.address
      : pool.tokenA.address;
  const range = rangeFromPreset(pool.priceUsd || 1, "full", pool.feePct);
  const data = encodeDeployData({
    abi: PROBE_ABI,
    bytecode: PROBE_BYTECODE,
    args: [
      CONTRACTS.weth,
      CONTRACTS.npm,
      CONTRACTS.swapRouter02,
      token as Hex,
      feeToPips(pool.feePct),
      range.tickLower,
      range.tickUpper,
    ],
  });
  // Fixed non-user address; overridden balance exists for this single simulation.
  const account = "0x000000000000000000000000000000000000bEEF" as const;
  const result = await publicClient().call({
    account,
    data,
    value: amount + OPERATOR_STIPEND,
    gas: 12_000_000n,
    stateOverride: [{ address: account, balance: parseEther("100") }],
  });
  if (!result.data || result.data.length !== 66)
    throw new Error("Round-trip simulation returned no valuation");
  const recovered = BigInt(result.data);
  if (recovered < (amount * 97n) / 100n) throw new Error("Round-trip loses more than 3%");
  return { lossEth: Number(formatEther(amount > recovered ? amount - recovered : 0n)) };
}

/** Write the signed transaction hash to durable storage BEFORE broadcast. A crash
 * at any point leaves an intent to reconcile, never an excuse to send again. */
export async function broadcastPrepared(args: {
  pk: Hex;
  vault: string;
  data: Hex;
  gas: bigint;
  beforeBroadcast: (hash: Hex) => Promise<void>;
}) {
  const client = publicClient();
  const account = privateKeyToAccount(args.pk);
  const wallet = createWalletClient({ account, chain: robinhoodChain, transport });
  const request = await wallet.prepareTransactionRequest({
    to: args.vault as Hex,
    data: args.data,
    gas: args.gas,
  });
  const maxFee = request.maxFeePerGas ?? request.gasPrice ?? (await client.getGasPrice());
  const balance = await client.getBalance({ address: account.address });
  if (balance < args.gas * maxFee * 3n)
    throw new Error("Keeper gas reserve cannot cover this transaction plus two exits");
  const signed = await wallet.signTransaction(request);
  const hash = keccak256(signed);
  await args.beforeBroadcast(hash);
  await client.sendRawTransaction({ serializedTransaction: signed });
  return hash;
}

export { WETH };
