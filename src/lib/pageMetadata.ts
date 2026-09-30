import type { Metadata } from "next";

/**
 * Shared page-metadata builder for every route that defines its own
 * metadata. The root layout supplies the title template ("%s |
 * SOL.repair"), so pages pass their BARE title; this helper fills in
 * everything the layout cannot provide per page: the route's own
 * canonical, and Open Graph / Twitter fields that name the page itself
 * instead of the homepage.
 *
 * This exists because a page without its own metadata inherits the
 * root layout's canonical "/" and homepage title verbatim, which tells
 * search engines the page is a duplicate of the homepage (the exact
 * defect that hit /fees, /understand, and /report). The route-metadata
 * test enforces that every non-root page uses this builder's contract.
 */

const SITE_NAME = "SOL.repair";
const SITE_ORIGIN = "https://sol.repair";

/**
 * The share-card image. It is generated at build time by the root
 * app/opengraph-image.tsx file convention, which injects og:image only
 * into the root segment. A page that defines its own openGraph object
 * REPLACES the root's (metadata merges shallowly), and the file-based
 * image does not follow it down, so every page-level openGraph must
 * reference the generated route itself. Relative URL, resolved against
 * metadataBase. Dimensions and alt match the file convention.
 */
const SHARE_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: "SOL.repair - reclaim SOL from empty token accounts",
};

export function pageMetadata(page: {
  /** Bare page title, without the "| SOL.repair" suffix. */
  title: string;
  description: string;
  /** The route's own path, e.g. "/guides/solana-rent". Becomes the canonical. */
  path: string;
}): Metadata {
  const fullTitle = `${page.title} | ${SITE_NAME}`;
  return {
    // Bare title: the layout's template appends the site name for the
    // <title> tag. Open Graph and Twitter get no template treatment,
    // so they carry the full title explicitly.
    title: page.title,
    description: page.description,
    alternates: { canonical: page.path },
    openGraph: {
      title: fullTitle,
      description: page.description,
      url: `${SITE_ORIGIN}${page.path}`,
      siteName: SITE_NAME,
      type: "website",
      images: [SHARE_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description: page.description,
      images: [SHARE_IMAGE.url],
    },
  };
}
