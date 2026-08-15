import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";
import { SolanaProvider } from "@/components/SolanaProvider";
import { IS_MAINNET } from "@/lib/solana/connection";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SOL.repair | Solana Wallet Repair",
  description:
    "Find unused Solana token accounts and recover the SOL locked inside them as account rent. Non-custodial.",
  // Hidden from search engines everywhere except mainnet. Gated on the same
  // env var as the network itself, so the mainnet launch can't forget to
  // lift it, and a misconfigured build fails hidden rather than exposed.
  robots: IS_MAINNET
    ? { index: true, follow: true }
    : { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-black text-zinc-100">
        <SolanaProvider>{children}</SolanaProvider>
        {/* Privacy-friendly aggregate visit counting. No cookies, no
            cross-site tracking (see /privacy). */}
        <Analytics />
      </body>
    </html>
  );
}
