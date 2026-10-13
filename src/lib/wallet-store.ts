import { create } from "zustand";
import { ROBINHOOD_CHAIN, ROBINHOOD_CHAIN_HEX, ROBINHOOD_CHAIN_ID } from "./chain";

type WcProvider = {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

type Eip6963Detail = { info: { rdns?: string; name?: string }; provider: WcProvider };

let provider: WcProvider | null = null;
let listening = false;

/** Browser wallet discovery: EIP-6963 first (picks MetaMask/Rabby when several), then window.ethereum. */
async function discover(): Promise<WcProvider | null> {
  if (typeof window === "undefined") return null;
  const found: Eip6963Detail[] = [];
  const onAnnounce = (e: Event) => found.push((e as CustomEvent<Eip6963Detail>).detail);
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, 150));
  window.removeEventListener("eip6963:announceProvider", onAnnounce);
  if (found.length) {
    const preferred =
      found.find((d) => d.info.rdns === "io.metamask") ?? found.find((d) => d.info.rdns === "io.rabby") ?? found[0];
    return preferred.provider;
  }
  return (window as unknown as { ethereum?: WcProvider }).ethereum ?? null;
}

async function wc(): Promise<WcProvider> {
  if (provider) return provider;
  const p = await discover();
  if (!p) throw new Error("No browser wallet found. Install MetaMask or Rabby, or open Perch inside your wallet's browser.");
  provider = p;
  return p;
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
    // Injected wallets cannot be disconnected by a site; just forget the session locally.
    set({ address: null, error: null, chainId: null });
  },

  connect: async () => {
    set({ connecting: true, error: null });
    try {
      const p = await wc();
      if (!listening && p.on) {
        listening = true;
        p.on("accountsChanged", (...args: unknown[]) => {
          const accounts = (args[0] as string[]) ?? [];
          set({ address: accounts[0] ?? null });
        });
        p.on("chainChanged", (...args: unknown[]) => {
          const raw = String(args[0] ?? "");
          const n = Number.parseInt(raw, raw.startsWith("0x") ? 16 : 10);
          set({ chainId: Number.isFinite(n) ? n : null });
        });
      }
      const accounts = ((await p.request({ method: "eth_requestAccounts" })) as string[]) ?? [];
      const chainRaw = (await p.request({ method: "eth_chainId" })) as string;
      const chainId = Number.parseInt(String(chainRaw), String(chainRaw).startsWith("0x") ? 16 : 10);
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
