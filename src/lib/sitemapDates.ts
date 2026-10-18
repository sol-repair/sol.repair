/**
 * Static last-modified dates for the sitemap, one entry per public URL.
 *
 * Discipline: bump a page's date in the same commit that changes its
 * content. The sitemap used to stamp new Date() into every entry at
 * build time, so every deploy claimed all 14 URLs had just changed and
 * lastmod carried no information. The values here were derived from git
 * history (git log -1 --format=%cs -- <route path under src/app>) and
 * are date-only ISO strings; sitemap.ts builds Date objects from them.
 *
 * /changelog is the one entry whose content also lives outside its page
 * file: its date is the later of src/app/changelog/page.tsx and
 * src/lib/changelog.ts. A new page joins the sitemap and this record in
 * the same commit, or the sync pin in tests/sitemapRobots.test.ts
 * fails.
 */
export const LAST_MODIFIED: Record<string, string> = {
  "/": "2026-10-17",
  "/fees": "2026-09-30",
  "/understand": "2026-09-30",
  "/report": "2026-09-30",
  "/changelog": "2026-10-17",
  "/guides/random-tokens": "2026-10-17",
  "/guides/rent-reduction": "2026-10-17",
  "/guides/solana-rent": "2026-10-17",
  "/guides/token-approvals": "2026-10-17",
  "/guides/close-token-accounts": "2026-10-17",
  "/guides/what-did-i-just-sign": "2026-10-17",
  "/guides": "2026-10-17",
  "/terms": "2026-10-17",
  "/privacy": "2026-10-17",
};
