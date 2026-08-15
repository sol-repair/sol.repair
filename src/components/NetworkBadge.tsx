import { NETWORK_LABEL, IS_MAINNET } from "@/lib/solana/connection";

/**
 * Small badge that always shows the active network. Per the spec, devnet must
 * be clearly visible during development so the network is impossible to
 * confuse. On mainnet the badge is present but less prominent.
 */
export function NetworkBadge() {
  if (IS_MAINNET) {
    return (
      <span className="rounded border border-zinc-700 px-2 py-0.5 font-mono text-xs text-zinc-400">
        {NETWORK_LABEL}
      </span>
    );
  }

  return (
    <span
      className="rounded border border-yellow-600/50 bg-yellow-500/10 px-2 py-0.5 font-mono text-xs text-yellow-400"
      title="The app is connected to a Solana test network (not mainnet). Transactions use fake SOL. Switching to mainnet is an explicit config change."
    >
      {NETWORK_LABEL} (test funds only)
    </span>
  );
}
