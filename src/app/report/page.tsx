import type { Metadata } from "next";
import { pageMetadata } from "@/lib/pageMetadata";
import ReportPage from "./report-client";

/**
 * Server wrapper so the route owns its metadata. The interactive page
 * is the colocated client component; a "use client" page cannot export
 * metadata and would inherit the homepage's canonical and title.
 */
export const metadata: Metadata = pageMetadata({
  title: "Solana wallet health report",
  description:
    "Connect a wallet to see every token account it owns: which are empty and closable, how much rent each holds, and which are delegated or frozen. Read-only.",
  path: "/report",
});

export default function Page() {
  return <ReportPage />;
}
