import Link from "next/link";
import { GUIDES } from "@/lib/guides";

export default function GuidesSection() {
  return (
    <section className="mt-12 border-t border-zinc-900 pt-6">
      <h2 className="text-sm font-semibold text-zinc-200">Guides</h2>
      <div className="mt-3 space-y-3">
        {GUIDES.map((guide) => (
          <div key={guide.href}>
            <Link
              href={guide.href}
              className="text-sm text-zinc-300 underline underline-offset-2 hover:text-white"
            >
              {guide.title}
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
