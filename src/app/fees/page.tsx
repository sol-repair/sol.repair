import type { Metadata } from "next";
import { pageMetadata } from "@/lib/pageMetadata";
import FeesPage from "./fees-client";

/**
 * Server wrapper so the route owns its metadata. The interactive page
 * is the colocated client component; a "use client" page cannot export
 * metadata and would inherit the homepage's canonical and title.
 */
export const metadata: Metadata = pageMetadata({
  title: "Fee ledger",
  description:
    "Every 1% fee SOL.repair has ever charged, read live from the Solana chain. Each row links to its transaction so anyone can verify it independently.",
  path: "/fees",
});

export default function Page() {
  return <FeesPage />;
}
