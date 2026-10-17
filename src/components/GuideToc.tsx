/**
 * The "On this page" contents list at the top of a guide. Items link to
 * the section headings on the same page (each h2 carries a matching id).
 * A pure listing: no scores, no judgment, just the page's own structure.
 */
export function GuideToc({
  items,
}: {
  items: { href: string; label: string }[];
}) {
  return (
    <nav
      aria-label="On this page"
      className="mb-8 rounded-lg border border-zinc-800 bg-zinc-950 p-4"
    >
      <p className="font-mono text-[11px] uppercase tracking-wider text-zinc-400">
        On this page
      </p>
      <ul className="mt-2 gap-x-6 text-sm sm:columns-2">
        {items.map((item) => (
          <li key={item.href} className="break-inside-avoid">
            <a
              href={item.href}
              className="text-zinc-400 transition-colors hover:text-zinc-200"
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
