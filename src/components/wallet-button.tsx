import { Wallet } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { formatAddress } from "@/lib/format";
import { isRobinhoodChain, useWallet } from "@/lib/wallet-store";

export function WalletButton() {
  const { address, connecting, connect, disconnect, chainId, error } = useWallet();
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Wallet className="size-4" />
          Connect
        </Button>
      </DialogTrigger>
      <DialogContent title="Connect your wallet">
        <p className="mb-4 text-sm text-muted">
          Use your browser wallet (MetaMask, Rabby…). On mobile, open Perch inside your
          wallet app's browser. Each wallet gets its own vault.
        </p>
        <div className="flex flex-col gap-2">
          <Button
            onClick={async () => {
              await connect();
              if (useWallet.getState().address) setOpen(false);
            }}
            disabled={connecting}
          >
            {connecting ? "Waiting for wallet…" : "Browser wallet"}
          </Button>
        </div>
        {error ? <p className="mt-3 text-sm text-down">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
