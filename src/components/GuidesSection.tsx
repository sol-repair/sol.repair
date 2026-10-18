import Link from "next/link";
import { GUIDES } from "@/lib/guides";

/**
 * Homepage guides section. Same visual language as the tools section:
 * titled links with an arrow, one-line summary under each. The optional
 * step number continues the homepage's numbered section labels; other
 * callers omit it.
 */
export default function GuidesSection({ step }: { step?: string }) {
  return (
    <section className="mt-10">
      <h2 className="font-mono text-[11px] font-medium uppercase tracking-wider text-zinc-400">
        {step && (
          <span aria-hidden="true" className="text-zinc-400">{step}</span>
        )}{" "}
        <span className="text-emerald-400">Guides</span>
      </h2>
      <div className="mt-3 space-y-4">
        {GUIDES.map((guide) => (
          <div key={guide.href}>
            <Link
              href={guide.href}
              className="flex items-baseline justify-between gap-3 text-sm text-zinc-200 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-white"
            >
              <span>{guide.title}</span>
              <span aria-hidden="true" className="text-zinc-500">
                →
              </span>
            </Link>
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">
              {guide.summary}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
