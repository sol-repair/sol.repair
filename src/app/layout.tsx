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
  metadataBase: new URL("https://sol.repair"),
  // The template appends the site name to every child page's bare
  // title (see src/lib/pageMetadata.ts). The default is the homepage's
  // own title: the homepage is a client component and defines no
  // metadata of its own, so it falls back to this.
  title: {
    default: "SOL.repair | Reclaim SOL from Empty Token Accounts",
    template: "%s | SOL.repair",
  },
  description:
    "Find unused Solana token accounts and recover the SOL locked inside them as account rent. Non-custodial.",
  // Canonical for the homepage only. Every other page overrides this
  // with its own path via pageMetadata(); a page that silently inherits
  // it declares itself a duplicate of the homepage.
  alternates: { canonical: "/" },
  openGraph: {
    title: "SOL.repair | Reclaim SOL from Empty Token Accounts",
    description:
      "Empty token accounts lock about 0.00149 to 0.00208 SOL each as rent. Close them in a few transactions you sign yourself. Non-custodial, 1% success fee.",
    url: "https://sol.repair",
    siteName: "SOL.repair",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "SOL.repair | Reclaim SOL from Empty Token Accounts",
    description:
      "Empty token accounts lock about 0.00149 to 0.00208 SOL each as rent. Close them in a few transactions you sign yourself.",
  },
  // Hidden from search engines everywhere except mainnet. Gated on the same
  // env var as the network itself, so the mainnet launch can't forget to
  // lift it, and a misconfigured build fails hidden rather than exposed.
  // Mainnet emits NO robots meta at all (absence means the crawler default,
  // index/follow) instead of an explicit "index, follow": the framework
  // adds its own noindex to the not-found page, and two conflicting robots
  // metas on one page is an ambiguous signal no page should ship.
  robots: IS_MAINNET ? undefined : { index: false, follow: false },
};

const structuredData = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "SOL.repair",
  url: "https://sol.repair",
  applicationCategory: "FinanceApplication",
  operatingSystem: "Web",
  description:
    "Finds empty Solana token accounts and closes them, returning the locked account rent to the user's own wallet. Non-custodial.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-black text-zinc-100">
        <SolanaProvider>{children}</SolanaProvider>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
        {/* Privacy-friendly aggregate visit counting. No cookies, no
            cross-site tracking (see /privacy). */}
        <Analytics />
      </body>
    </html>
  );
}
