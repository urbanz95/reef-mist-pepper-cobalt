import { Wallet } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { formatAddress } from "@/lib/format";
import { isRobinhoodChain, useWallet, walletConnectReady } from "@/lib/wallet-store";

export function WalletButton() {
  const { address, connecting, connect, connectInjected, disconnect, enableDemo, demo, chainId, error, hasBrowserWallet } =
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
      <DialogContent title="Connect a wallet">
        <p className="mb-4 text-sm text-muted">
          The gray WalletConnect box is an empty QR. That public project id is rejected, so no code is generated.
        </p>
        <div className="flex flex-col gap-2">
          <Button
            onClick={async () => {
              await connectInjected();
              if (useWallet.getState().address) setOpen(false);
            }}
            disabled={connecting}
          >
            {connecting ? "Waiting for the wallet…" : hasBrowserWallet ? "Browser wallet" : "Browser wallet (MetaMask / Rabby)"}
          </Button>
          <Button
            variant="secondary"
            onClick={async () => {
              await connect();
              if (useWallet.getState().address) setOpen(false);
            }}
            disabled={connecting || !walletConnectReady}
          >
            {walletConnectReady ? "WalletConnect" : "WalletConnect unavailable"}
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
        {!walletConnectReady ? (
          <p className="mt-3 text-xs text-subtle">
            Phone QR needs your own project id in VITE_WC_PROJECT_ID from dashboard.reown.com. Until then, use the browser wallet.
          </p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-down">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
