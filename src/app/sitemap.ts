import type { MetadataRoute } from "next";

/**
 * Sitemap for the three public pages. The homepage is the product; the two
 * legal pages are included so crawlers have a complete map, weighted low.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://sol.repair";
  return [
    {
      url: base,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${base}/terms`,
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${base}/privacy`,
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
