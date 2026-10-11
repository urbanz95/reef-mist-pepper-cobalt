import { tokenHue } from "@/lib/format";
import { cn } from "@/lib/cn";

export function TokenAvatar({
  symbol,
  address,
  image,
  size = "md",
}: {
  symbol: string;
  address: string;
  image?: string | null;
  size?: "sm" | "md" | "lg";
}) {
  const hue = tokenHue(address || symbol);
  const dim = size === "sm" ? "size-7 text-[10px]" : size === "lg" ? "size-11 text-sm" : "size-9 text-xs";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold tracking-wide text-fg",
        dim,
      )}
      style={{ background: `oklch(0.38 0.08 ${hue})` }}
    >
      {image ? (
        <img src={image} alt="" className="size-full object-cover" />
      ) : (
        symbol.slice(0, 2).toUpperCase()
      )}
    </span>
  );
}

export function PairAvatar({
  a,
  b,
  addrA,
  addrB,
  imageA,
  imageB,
}: {
  a: string;
  b: string;
  addrA: string;
  addrB: string;
  imageA?: string | null;
  imageB?: string | null;
}) {
  return (
    <span className="flex items-center">
      <TokenAvatar symbol={a} address={addrA} image={imageA} />
      <span className="-ml-2">
        <TokenAvatar symbol={b} address={addrB} image={imageB} />
      </span>
    </span>
  );
}
