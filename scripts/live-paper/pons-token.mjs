import { keccak256, parseAbi, zeroAddress } from "viem";
import { resolvePonsMeta } from "./pons-market.mjs";

// PonsV2LauncherToken, solc 0.8.35, verified Sourcify runtime. Only the four
// compiler-declared immutable words are normalized. Metadata and ALL executable
// bytes remain pinned. See docs/paper-rotation.md for source and review scope.
export const PONS_TOKEN_TEMPLATE_HASH =
  "0xfaa55f9f9b0db66181468400d0609ed9b9499520e5c0dbb04561042781ef391f";
export function verifyPonsTokenRuntime(code, { deployer, curve, factory }) {
  if (!/^0x[0-9a-f]{6496}$/i.test(code ?? "")) return false;
  let normalized = code.toLowerCase();
  for (const [offset, value] of [
    [379, deployer],
    [529, deployer],
    [1094, curve],
    [1357, factory],
  ]) {
    if (!/^0x[0-9a-f]{40}$/i.test(value ?? "") || value.toLowerCase() === zeroAddress) return false;
    const start = 2 + offset * 2,
      word = value.slice(2).toLowerCase().padStart(64, "0");
    if (normalized.slice(start, start + 64) !== word) return false;
    normalized = normalized.slice(0, start) + "0".repeat(64) + normalized.slice(start + 64);
  }
  return keccak256(normalized) === PONS_TOKEN_TEMPLATE_HASH;
}
const abi = parseAbi([
  "function balanceOf(address) view returns(uint256)",
  "function totalSupply() view returns(uint256)",
]);
/** Registration/factory/hook are independently pinned by resolvePonsMeta. */
export async function ponsTokenProof(client, pool, snapshot) {
  const m = await resolvePonsMeta(client, pool, snapshot);
  const [code, supply, balance] = await Promise.all([
    client.getBytecode({ address: m.other, blockNumber: BigInt(snapshot.block) }),
    client.readContract({
      address: m.other,
      abi,
      functionName: "totalSupply",
      blockNumber: BigInt(snapshot.block),
    }),
    client.readContract({
      address: m.other,
      abi,
      functionName: "balanceOf",
      args: [m.record.deployer],
      blockNumber: BigInt(snapshot.block),
    }),
  ]);
  if (
    !verifyPonsTokenRuntime(code, {
      deployer: m.record.deployer,
      curve: m.curve,
      factory: m.stack.factory,
    })
  )
    return null;
  if (supply <= 0n || balance > supply) return null;
  return {
    kind: "pinned-pons-ownerless-erc20",
    block: snapshot.block,
    token: m.other,
    runtimeHash: keccak256(code),
    templateHash: PONS_TOKEN_TEMPLATE_HASH,
    issuer: m.record.deployer.toLowerCase(),
    issuerFraction: Number(balance) / Number(supply),
    issuerOverLimit: balance * 100n > supply,
    // Reviewed runtime has standard ERC20/Burnable transfers, no Ownable,
    // proxy, transfer override, mint entry point or post-construction setter.
    owner: zeroAddress,
    fullBalanceTransfers: true,
  };
}
export function applyPonsTokenProof(raw, proof, token, block) {
  if (
    !raw ||
    !proof ||
    proof.kind !== "pinned-pons-ownerless-erc20" ||
    proof.templateHash !== PONS_TOKEN_TEMPLATE_HASH ||
    proof.owner !== zeroAddress ||
    proof.fullBalanceTransfers !== true ||
    proof.token !== token ||
    proof.block !== block
  )
    return raw;
  // Explicit positive provider risks are never cleared by this adapter.
  const owner = raw.owner_address;
  return {
    ...raw,
    ...(!owner ? { owner_address: zeroAddress, owner_percent: "0" } : {}),
    ...(raw.cannot_sell_all === undefined ? { cannot_sell_all: "0" } : {}),
    // GoPlus reports the deployment helper as creator. The immutable deployer
    // and verified launch record identify the actual issuer; read its holdings.
    creator_address: proof.issuer,
    creator_percent: String(proof.issuerFraction),
  };
}
