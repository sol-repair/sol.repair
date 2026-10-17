import { NETWORK_LABEL, IS_MAINNET } from "@/lib/solana/connection";

/**
 * Small badge that always shows the active network. Per the spec, devnet must
 * be clearly visible during development so the network is impossible to
 * confuse. On mainnet the badge is present but less prominent.
 */
export function NetworkBadge() {
  // whitespace-nowrap: the badge is a status chip; a narrow flex row must
  // wrap it to its own line whole, never crush it into a multiline pill.
  if (IS_MAINNET) {
    return (
      <span className="whitespace-nowrap rounded border border-zinc-700 px-2 py-0.5 font-mono text-xs text-zinc-400">
        {NETWORK_LABEL}
      </span>
    );
  }

  return (
    <span
      className="whitespace-nowrap rounded border border-yellow-600/50 bg-yellow-500/10 px-2 py-0.5 font-mono text-xs text-yellow-400"
      title="The app is connected to a Solana test network (not mainnet). Transactions use fake SOL. Switching to mainnet is an explicit config change."
    >
      {NETWORK_LABEL} (test funds only)
    </span>
  );
}
