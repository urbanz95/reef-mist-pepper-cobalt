import { Wallet } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { formatAddress } from "@/lib/format";
import { isRobinhoodChain, useWallet } from "@/lib/wallet-store";

export function WalletButton() {
  const { address, connecting, connect, disconnect, enableDemo, demo, chainId, error } =
    useWallet();
  const [open, setOpen] = useState(false);

  if (address) {
    return (
      <div className="flex items-center gap-2">
        {!isRobinhoodChain(chainId) ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void useWallet.getState().switchChain()}
          >
            Switch network
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void disconnect()}
          className="font-mono text-xs"
        >
          {formatAddress(address)}
        </Button>
      </div>
    );
  }

  if (demo) {
    return (
      <Button variant="secondary" size="sm" onClick={() => void disconnect()}>
        Demo · exit
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Wallet className="size-4" />
          Connect
        </Button>
      </DialogTrigger>
      <DialogContent title="Connect with WalletConnect">
        <p className="mb-4 text-sm text-muted">
          Scan the QR in your wallet (Rainbow, MetaMask mobile, Rabby…). No injected
          browser extension. Each wallet gets its own vault.
        </p>
        <div className="flex flex-col gap-2">
          <Button
            onClick={async () => {
              await connect();
              if (useWallet.getState().address) setOpen(false);
            }}
            disabled={connecting}
          >
            {connecting ? "Opening WalletConnect…" : "WalletConnect"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              enableDemo();
              setOpen(false);
            }}
          >
            Continue in demo mode
          </Button>
        </div>
        {error ? <p className="mt-3 text-sm text-down">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
