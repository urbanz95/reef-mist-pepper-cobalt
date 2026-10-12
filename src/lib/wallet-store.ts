import { create } from "zustand";
import { ROBINHOOD_CHAIN, ROBINHOOD_CHAIN_HEX, ROBINHOOD_CHAIN_ID } from "./chain";

const WC_PROJECT_ID =
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: { VITE_WC_PROJECT_ID?: string } }).env?.VITE_WC_PROJECT_ID) ||
  "c4f79cc821944d9680842e34466bfbd9";

type WcProvider = {
  accounts?: string[];
  chainId?: number | string;
  connect: () => Promise<unknown>;
  disconnect: () => Promise<unknown>;
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
};

let provider: WcProvider | null = null;

async function wc(): Promise<WcProvider> {
  if (provider) return provider;
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  provider = (await EthereumProvider.init({
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
      icons: [typeof window !== "undefined" ? `${window.location.origin}/favicon.svg` : ""],
    },
  })) as unknown as WcProvider;
  return provider;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  switchChain: () => Promise<void>;
  sendTx: (tx: TxRequest) => Promise<string>;
  signMessage: (message: string) => Promise<string>;
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

  disconnect: async () => {
    try {
      await provider?.disconnect();
    } catch {
      /* ignore */
    }
    set({ address: null, error: null, chainId: null });
  },

  connect: async () => {
    set({ connecting: true, error: null });
    try {
      const p = await wc();
      p.on("accountsChanged", (...args: unknown[]) => {
        const accounts = (args[0] as string[]) ?? [];
        set({ address: accounts[0] ?? null });
      });
      p.on("chainChanged", (...args: unknown[]) => {
        const raw = String(args[0] ?? "");
        const n = Number.parseInt(raw, raw.startsWith("0x") ? 16 : 10);
        set({ chainId: Number.isFinite(n) ? n : ROBINHOOD_CHAIN_ID });
      });
      p.on("disconnect", () => {
        set({ address: null, chainId: null });
      });
      await p.connect();
      const accounts = (p.accounts ?? []) as string[];
      const chainRaw = p.chainId;
      const chainId =
        typeof chainRaw === "number"
          ? chainRaw
          : Number.parseInt(String(chainRaw), String(chainRaw).startsWith("0x") ? 16 : 10);
      set({
        address: accounts[0] ?? null,
        chainId: Number.isFinite(chainId) ? chainId : null,
        connecting: false,
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
    const p = await wc();
    try {
      await p.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ROBINHOOD_CHAIN_HEX }],
      });
      set({ chainId: ROBINHOOD_CHAIN_ID });
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code === 4902) {
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
    const p = await wc();
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

  signMessage: async (message) => {
    const p = await wc();
    const { address } = get();
    if (!address) throw new Error("Wallet not connected");
    const hex = `0x${Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    return (await p.request({ method: "personal_sign", params: [hex, address] })) as string;
  },

  waitReceipt: async (hash) => {
    const p = await wc();
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
    const p = await wc();
    return (await p.request({
      method: "eth_call",
      params: [{ to, data }, "latest"],
    })) as string;
  },

  getCode: async (address) => {
    const p = await wc();
    return (await p.request({
      method: "eth_getCode",
      params: [address, "latest"],
    })) as string;
  },

  getBalance: async (address) => {
    const p = await wc();
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
