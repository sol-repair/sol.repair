import Link from "next/link";
import { NetworkBadge } from "@/components/NetworkBadge";

/**
 * The slim site header, on every page: wordmark (a link home) and the
 * network badge on the left, three read-only destinations on the right.
 * Navigation lives up here so no page depends on its footer or a single
 * back link for wayfinding. The nav destinations are all read-only
 * surfaces; nothing that signs is ever one tap away in the chrome.
 *
 * Labels render uppercase through CSS, so the accessible names stay
 * "Understand", "Guides", "Fees".
 */

const NAV_ITEMS = [
  { key: "understand", href: "/understand", label: "Understand" },
  { key: "guides", href: "/guides", label: "Guides" },
  { key: "fees", href: "/fees", label: "Fees" },
] as const;

export type SiteSection = (typeof NAV_ITEMS)[number]["key"];

export function SiteHeader({ active }: { active?: SiteSection }) {
  return (
    <div className="mb-8 flex items-center justify-between gap-3">
      <Link
        href="/"
        className="shrink-0 font-mono text-sm text-zinc-400 transition-colors hover:text-zinc-200"
      >
        SOL.repair
      </Link>
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        <nav aria-label="Site" className="flex items-center gap-3 sm:gap-4">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={active === item.key ? "page" : undefined}
              className={`whitespace-nowrap font-mono text-[11px] uppercase tracking-wider transition-colors ${
                active === item.key
                  ? "text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <NetworkBadge />
      </div>
    </div>
  );
}
