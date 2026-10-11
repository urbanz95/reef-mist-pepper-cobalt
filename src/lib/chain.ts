export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_CHAIN_HEX = "0x1237";

export const ROBINHOOD_CHAIN = {
  chainId: ROBINHOOD_CHAIN_HEX,
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
} as const;

/** Official Uniswap + token deployments on Robinhood Chain (4663). */
export const CONTRACTS = {
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  universalRouter: "0x8876789976DECbfcBbbe364623c63652db8c0904",
  v2Factory: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f",
  v2Router: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba",
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  npm: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
  swapRouter02: "0xCaf681a66D020601342297493863E78C959E5cb2",
  quoterV2: "0x33E885ed0eC9Bf04ECfb19341582AAdcb4c8A9E7",
  tickLens: "0x7Dfd4F31Be6814d2906BDE155c3e1B146eAC1468",
  multicall: "0x282A3c4d320Cc7f0D5EaF56b8029e4B88338F0A3",
  nftDescriptor: "0x2E9D45bb7B30549F5216813aDA9A6b7982C5B3Ed",
  npmDescriptor: "0x6f84Dae9C064Ff453e5C8af51EFb819f8f610225",
  v4PoolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  v4PositionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7",
  v4PositionDescriptor: "0x9639443158E8C5efa35Bd45287bf2EFfd3D8dC06",
  v4Quoter: "0x8Dc178efB8111BB0973Dd9d722EBeFF267C98f94",
  v4StateView: "0xf3334192d15450cDD385c8B70e03F9A6BD9e673b",
  v4ReservesLens: "0x0000001b173C3bbF3984D417d8614E3eed34865B",
} as const;

export type ContractId = keyof typeof CONTRACTS;

export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const UNISWAP_APP = "https://app.uniswap.org";

export function explorerAddress(address: string) {
  return `${EXPLORER}/address/${address}`;
}

export function explorerTx(hash: string) {
  return `${EXPLORER}/tx/${hash}`;
}

export function uniswapPoolUrl(poolId: string) {
  return `${UNISWAP_APP}/explore/pools/robinhood/${poolId}`;
}

export function uniswapAddLiquidityUrl(args: {
  tokenA: string;
  tokenB: string;
  fee: number;
}) {
  const fee = Math.round(args.fee * 10000);
  const params = new URLSearchParams({
    currencyA: args.tokenA,
    currencyB: args.tokenB,
    chain: "robinhood",
    fee: String(fee),
  });
  return `${UNISWAP_APP}/positions/create?${params.toString()}`;
}

export const FEE_TICK_SPACING: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

export function feeToPips(feePct: number) {
  return Math.round(feePct * 10000);
}

export function isEvmAddress(value: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}
