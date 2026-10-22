import type { Metadata } from "next";
import { pageMetadata } from "@/lib/pageMetadata";
import { SolanaProvider } from "@/components/SolanaProvider";
import UnderstandPage from "./understand-client";

/**
 * Server wrapper so the route owns its metadata. The interactive page
 * is the colocated client component; a "use client" page cannot export
 * metadata and would inherit the homepage's canonical and title.
 *
 * The Solana provider moved out of the root layout (it pinned the
 * wallet-adapter chunk onto every route), so this route mounts it at
 * its own root, above the client page, exactly where the layout used
 * to provide it.
 */
export const metadata: Metadata = pageMetadata({
  title: "Understand a Solana transaction",
  description:
    "Paste a Solana transaction signature and get a plain-language explanation of what it did and what permissions it left behind. Read-only, no signing.",
  path: "/understand",
});

export default function Page() {
  return (
    <SolanaProvider>
      <UnderstandPage />
    </SolanaProvider>
  );
}
