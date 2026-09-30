/**
 * Structured data for the guide pages. BreadcrumbList mirrors the
 * visible breadcrumb (Guides / title) and TechArticle describes the
 * page itself. Both strictly represent content a reader can see on
 * the page; no FAQPage, no HowTo, no ratings, nothing the page does
 * not contain.
 *
 * Dates: datePublished is the guide's first git commit date,
 * dateModified its last content change. Nothing may claim a refresh
 * that did not happen.
 */

const SITE_NAME = "SOL.repair";
const SITE_ORIGIN = "https://sol.repair";

export type GuideSchemaInput = {
  /** The guide's bare title, matching its H1. */
  title: string;
  /** The guide's meta description (also the article description). */
  description: string;
  /** Route path, e.g. "/guides/solana-rent". */
  path: string;
  /** ISO date (YYYY-MM-DD) of first publication. */
  datePublished: string;
  /** ISO date (YYYY-MM-DD) of the last content change. */
  dateModified: string;
};

const publisher = {
  "@type": "Organization",
  name: SITE_NAME,
  url: SITE_ORIGIN,
};

export function breadcrumbListSchema(input: GuideSchemaInput) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Guides",
        item: `${SITE_ORIGIN}/guides`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: input.title,
        item: `${SITE_ORIGIN}${input.path}`,
      },
    ],
  };
}

export function techArticleSchema(input: GuideSchemaInput) {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: input.title,
    description: input.description,
    url: `${SITE_ORIGIN}${input.path}`,
    mainEntityOfPage: `${SITE_ORIGIN}${input.path}`,
    datePublished: input.datePublished,
    dateModified: input.dateModified,
    inLanguage: "en",
    isAccessibleForFree: true,
    author: publisher,
    publisher,
  };
}

/** Both schema objects for one guide, as a JSON-LD array. */
export function guideSchema(input: GuideSchemaInput) {
  return [breadcrumbListSchema(input), techArticleSchema(input)];
}
