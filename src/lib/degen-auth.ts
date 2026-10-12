/**
 * Wallet-signature auth for Degen server functions. Shared by client and server:
 * the client signs `degenAuthMessage(...)` with personal_sign, the server checks
 * that the signature was made by the vault owner within a short window.
 */
export type DegenAuthAction = "pause" | "resume";

export const AUTH_WINDOW_MS = 5 * 60_000;

export function degenAuthMessage(action: DegenAuthAction, owner: string, timestamp: number) {
  return [
    "Perch Degen",
    `Action: ${action}`,
    `Wallet: ${owner.toLowerCase()}`,
    `Issued: ${timestamp}`,
    "Only sign this on the Perch app. It does not move funds.",
  ].join("\n");
}

/** Signature freshness: not older than the window, not from the future. */
export function authFresh(timestamp: number, now = Date.now()) {
  const age = now - timestamp;
  return Number.isFinite(age) && age <= AUTH_WINDOW_MS && age >= -60_000;
}

export type DegenAuth = { signature: `0x${string}`; timestamp: number };

export function isAddress(v: unknown): v is `0x${string}` {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

export function isTxHash(v: unknown): v is `0x${string}` {
  return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
}
