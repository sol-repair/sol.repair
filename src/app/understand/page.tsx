import type { Metadata } from "next";
import { pageMetadata } from "@/lib/pageMetadata";
import UnderstandPage from "./understand-client";

/**
 * Server wrapper so the route owns its metadata. The interactive page
 * is the colocated client component; a "use client" page cannot export
 * metadata and would inherit the homepage's canonical and title.
 */
export const metadata: Metadata = pageMetadata({
  title: "Understand a Solana transaction",
  description:
    "Paste a Solana transaction signature and get a plain-language explanation of what it did and what permissions it left behind. Read-only, no signing.",
  path: "/understand",
});

export default function Page() {
  return <UnderstandPage />;
}
