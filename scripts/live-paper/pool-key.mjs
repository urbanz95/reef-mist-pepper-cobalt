import { keccak256, encodeAbiParameters } from "viem";
export const keyType = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
};
export function poolKeyHash(key) {
  return keccak256(encodeAbiParameters([keyType], [key]));
}
