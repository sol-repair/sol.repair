import Link from "next/link";

/**
 * Visible breadcrumb shared by every guide page: Guides / [title].
 * Mirrors the BreadcrumbList structured data (src/lib/guideSchema.ts);
 * the two must never disagree, and the schema test pins that.
 */
export function GuideBreadcrumb({ title }: { title: string }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="mb-4 font-mono text-xs text-zinc-500"
    >
      <ol className="flex flex-wrap items-center gap-2">
        <li>
          <Link href="/guides" className="hover:text-zinc-300">
            Guides
          </Link>
        </li>
        <li aria-hidden="true" className="text-zinc-700">
          /
        </li>
        <li aria-current="page" className="text-zinc-400">
          {title}
        </li>
      </ol>
    </nav>
  );
}

/**
 * JSON-LD script tag for a guide's structured data. Rendered by the
 * server, one array of schema objects per guide.
 */
export function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
