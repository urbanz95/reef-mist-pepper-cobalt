import { create } from "zustand";
import { ROBINHOOD_CHAIN, ROBINHOOD_CHAIN_HEX, ROBINHOOD_CHAIN_ID } from "./chain";

const DEMO_WC_PROJECT_ID = "c4f79cc821944d9680842e34466bfbd9";

const WC_PROJECT_ID =
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: { VITE_WC_PROJECT_ID?: string } }).env?.VITE_WC_PROJECT_ID) ||
  "";

export const walletConnectReady =
  WC_PROJECT_ID.length > 8 && WC_PROJECT_ID !== DEMO_WC_PROJECT_ID;

type Eip1193 = {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
};

type WcProvider = Eip1193 & {
  accounts?: string[];
  chainId?: number | string;
  connect: () => Promise<unknown>;
  disconnect: () => Promise<unknown>;
};

let wcProvider: WcProvider | null = null;
let injected: Eip1193 | null = null;
let active: Eip1193 | null = null;

function browserWallet(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  return eth?.request ? eth : null;
}

async function wc(): Promise<WcProvider> {
  if (!walletConnectReady) {
    throw new Error(
      "WalletConnect has no project id, so the QR stays blank. Connect a browser wallet, or set VITE_WC_PROJECT_ID from dashboard.reown.com.",
    );
  }
  if (wcProvider) return wcProvider;
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  wcProvider = (await EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    showQrModal: true,
    chains: [1],
    optionalChains: [ROBINHOOD_CHAIN_ID, 1],
    rpcMap: {
      [ROBINHOOD_CHAIN_ID]: ROBINHOOD_CHAIN.rpcUrls[0],
      1: "https://eth.merkle.io",
    },
    metadata: {
      name: "Perch",
      description: "Degen liquidity on Robinhood Chain",
      url: typeof window !== "undefined" ? window.location.origin : "https://perch.app",
      icons: [],
    },
  })) as unknown as WcProvider;
  return wcProvider;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function requireProvider() {
  if (active) return active;
  if (injected) return injected;
  if (wcProvider) return wcProvider;
  const eth = browserWallet();
  if (eth) return eth;
  throw new Error("Wallet not connected");
}

function parseChainId(raw: unknown) {
  const text = String(raw ?? "");
  const n = Number.parseInt(text, text.startsWith("0x") ? 16 : 10);
  return Number.isFinite(n) ? n : null;
}

export type TxRequest = {
  to?: string;
  data: string;
  value?: string;
};

export type TxReceipt = {
  transactionHash: string;
  status: string;
  contractAddress?: string | null;
  logs?: { address?: string; topics?: string[]; data?: string }[];
};

type WalletState = {
  address: string | null;
  chainId: number | null;
  connecting: boolean;
  error: string | null;
  demo: boolean;
  hasBrowserWallet: boolean;
  connect: () => Promise<void>;
  connectInjected: () => Promise<void>;
  disconnect: () => Promise<void>;
  enableDemo: () => void;
  switchChain: () => Promise<void>;
  sendTx: (tx: TxRequest) => Promise<string>;
  waitReceipt: (hash: string) => Promise<TxReceipt>;
  ethCall: (to: string, data: string) => Promise<string>;
  getCode: (address: string) => Promise<string>;
  getBalance: (address: string) => Promise<bigint>;
};

export const useWallet = create<WalletState>((set, get) => ({
  address: null,
  chainId: null,
  connecting: false,
  error: null,
  demo: false,
  hasBrowserWallet: false,

  enableDemo: () => set({ demo: true, error: null }),

  disconnect: async () => {
    try {
      await wcProvider?.disconnect();
    } catch {
      /* ignore */
    }
    active = null;
    injected = null;
    set({ address: null, demo: false, error: null, chainId: null });
  },

  connectInjected: async () => {
    set({ connecting: true, error: null, demo: false });
    try {
      const eth = browserWallet();
      if (!eth) {
        throw new Error("No browser wallet. Install MetaMask or Rabby, then refresh.");
      }
      injected = eth;
      active = eth;
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const chainId = parseChainId(await eth.request({ method: "eth_chainId" }));
      eth.on?.("accountsChanged", (...args: unknown[]) => {
        const next = (args[0] as string[]) ?? [];
        set({ address: next[0] ?? null, demo: false });
      });
      eth.on?.("chainChanged", (...args: unknown[]) => {
        set({ chainId: parseChainId(args[0]) });
      });
      set({
        address: accounts[0] ?? null,
        chainId,
        connecting: false,
        demo: false,
        hasBrowserWallet: true,
      });
      if (chainId !== ROBINHOOD_CHAIN_ID) {
        await get().switchChain();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection rejected";
      set({ connecting: false, error: message });
    }
  },

  connect: async () => {
    set({ connecting: true, error: null, demo: false });
    try {
      const p = await wc();
      active = p;
      p.on?.("accountsChanged", (...args: unknown[]) => {
        const accounts = (args[0] as string[]) ?? [];
        set({ address: accounts[0] ?? null, demo: false });
      });
      p.on?.("chainChanged", (...args: unknown[]) => {
        set({ chainId: parseChainId(args[0]) ?? ROBINHOOD_CHAIN_ID });
      });
      p.on?.("disconnect", () => {
        set({ address: null, chainId: null });
      });
      await p.connect();
      const accounts = (p.accounts ?? []) as string[];
      const chainId = parseChainId(p.chainId);
      set({
        address: accounts[0] ?? null,
        chainId,
        connecting: false,
        demo: false,
      });
      if (chainId !== ROBINHOOD_CHAIN_ID) {
        await get().switchChain();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection rejected";
      set({ connecting: false, error: message });
    }
  },

  switchChain: async () => {
    const p = await requireProvider();
    try {
      await p.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ROBINHOOD_CHAIN_HEX }],
      });
      set({ chainId: ROBINHOOD_CHAIN_ID });
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code === 4902 || code === -32603) {
        await p.request({
          method: "wallet_addEthereumChain",
          params: [ROBINHOOD_CHAIN],
        });
        set({ chainId: ROBINHOOD_CHAIN_ID });
        return;
      }
      throw err;
    }
  },

  sendTx: async (tx) => {
    const p = await requireProvider();
    const { address } = get();
    if (!address) throw new Error("Wallet not connected");
    const params: Record<string, string> = {
      from: address,
      data: tx.data,
      value: tx.value ?? "0x0",
    };
    if (tx.to) params.to = tx.to;
    return (await p.request({
      method: "eth_sendTransaction",
      params: [params],
    })) as string;
  },

  waitReceipt: async (hash) => {
    const p = await requireProvider();
    for (let i = 0; i < 48; i++) {
      const raw = (await p.request({
        method: "eth_getTransactionReceipt",
        params: [hash],
      })) as TxReceipt | null;
      if (raw) return raw;
      await sleep(1500);
    }
    throw new Error("The transaction has not confirmed yet.");
  },

  ethCall: async (to, data) => {
    const p = await requireProvider();
    return (await p.request({
      method: "eth_call",
      params: [{ to, data }, "latest"],
    })) as string;
  },

  getCode: async (address) => {
    const p = await requireProvider();
    return (await p.request({
      method: "eth_getCode",
      params: [address, "latest"],
    })) as string;
  },

  getBalance: async (address) => {
    const p = await requireProvider();
    const hex = (await p.request({
      method: "eth_getBalance",
      params: [address, "latest"],
    })) as string;
    return BigInt(hex);
  },
}));

export function isRobinhoodChain(chainId: number | null) {
  return chainId === ROBINHOOD_CHAIN_ID;
}

if (typeof window !== "undefined") {
  queueMicrotask(() => {
    if (browserWallet()) useWallet.setState({ hasBrowserWallet: true });
  });
}
