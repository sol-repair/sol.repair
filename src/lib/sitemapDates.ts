/**
 * Static last-modified dates for the sitemap, one entry per public URL.
 *
 * Discipline: bump a page's date in the same commit that changes its
 * content, where content is every file under the route's directory
 * under src/app (the fees page's wording lives in fees-client.tsx, not
 * its page.tsx). The sitemap used to stamp new Date() into every entry
 * at build time, so every deploy claimed all 14 URLs had just changed
 * and lastmod carried no information. The values here were derived from
 * git history over those route directories (git log -1 --format=%cs --
 * <route directory>) and are date-only ISO strings; sitemap.ts builds
 * Date objects from them. "/" is keyed to src/app/page.tsx alone
 * because src/app/ also holds the layout, sitemap, and icon files that
 * are not homepage content.
 *
 * /changelog is the one entry whose content also lives outside its
 * route directory: its date is the later of src/app/changelog/ and
 * src/lib/changelog.ts. A new page joins the sitemap and this record in
 * the same commit, or the sync pin in tests/sitemapRobots.test.ts
 * fails; the same test file re-derives the git floor from the route
 * directories and fails any date that understates it.
 */
export const LAST_MODIFIED: Record<string, string> = {
  "/": "2026-10-25",
  "/fees": "2026-10-22",
  "/understand": "2026-10-22",
  "/report": "2026-10-22",
  "/changelog": "2026-10-25",
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
