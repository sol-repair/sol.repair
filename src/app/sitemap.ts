import type { MetadataRoute } from "next";

import { LAST_MODIFIED } from "@/lib/sitemapDates";

/**
 * Sitemap for the public pages. The homepage is the product; the guide
 * pages are the honest-explanation surface; the two legal pages are
 * included so crawlers have a complete map, weighted low.
 *
 * Dates come from LAST_MODIFIED, a static per-page record: bump a
 * page's date there in the same commit that changes its content, so
 * lastmod describes the page instead of the deploy.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://sol.repair";
  return [
    {
      url: base,
      lastModified: new Date(LAST_MODIFIED["/"]),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${base}/fees`,
      lastModified: new Date(LAST_MODIFIED["/fees"]),
      changeFrequency: "weekly",
      priority: 0.4,
    },
    {
      url: `${base}/understand`,
      lastModified: new Date(LAST_MODIFIED["/understand"]),
      changeFrequency: "weekly",
      priority: 0.4,
    },
    {
      url: `${base}/report`,
      lastModified: new Date(LAST_MODIFIED["/report"]),
      changeFrequency: "weekly",
      priority: 0.4,
    },
    {
      url: `${base}/changelog`,
      lastModified: new Date(LAST_MODIFIED["/changelog"]),
      changeFrequency: "weekly",
      priority: 0.4,
    },
    {
      url: `${base}/guides/random-tokens`,
      lastModified: new Date(LAST_MODIFIED["/guides/random-tokens"]),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${base}/guides/rent-reduction`,
      lastModified: new Date(LAST_MODIFIED["/guides/rent-reduction"]),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${base}/guides/solana-rent`,
      lastModified: new Date(LAST_MODIFIED["/guides/solana-rent"]),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${base}/guides/token-approvals`,
      lastModified: new Date(LAST_MODIFIED["/guides/token-approvals"]),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${base}/guides/close-token-accounts`,
      lastModified: new Date(LAST_MODIFIED["/guides/close-token-accounts"]),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${base}/guides/what-did-i-just-sign`,
      lastModified: new Date(LAST_MODIFIED["/guides/what-did-i-just-sign"]),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${base}/guides/repair-transaction`,
      lastModified: new Date(LAST_MODIFIED["/guides/repair-transaction"]),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${base}/guides`,
      lastModified: new Date(LAST_MODIFIED["/guides"]),
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${base}/terms`,
      lastModified: new Date(LAST_MODIFIED["/terms"]),
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${base}/privacy`,
      lastModified: new Date(LAST_MODIFIED["/privacy"]),
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
