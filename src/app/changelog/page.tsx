import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { pageMetadata } from "@/lib/pageMetadata";
import { CHANGELOG } from "@/lib/changelog";

/**
 * The product changelog: dated product news in plain language, newest
 * first. A static server page over the data list in src/lib/changelog.ts;
 * one data entry is one visible item, so future entries are hand edits
 * to that list alone.
 */
export const metadata: Metadata = pageMetadata({
  title: "Changelog",
  description:
    "What shipped on SOL.repair and when. Plain notes on every change to " +
    "the repair tool, the health report, the explainer, and the guides.",
  path: "/changelog",
});

export default function ChangelogPage() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-xl">
        <SiteHeader />

        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-zinc-50">
          Changelog
        </h1>
        <p className="mb-8 text-sm leading-relaxed text-zinc-400">
          What shipped on SOL.repair and when. Newest first.
        </p>

        <div className="space-y-8">
          {CHANGELOG.map((entry) => (
            <article key={entry.title}>
              <p className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">
                {entry.date}
              </p>
              <h2 className="mt-1 text-lg font-semibold text-zinc-50">
                {entry.title}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-zinc-400">
                {entry.body}
              </p>
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}
