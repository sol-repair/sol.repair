import type { MetadataRoute } from "next";
import { IS_MAINNET } from "@/lib/solana/connection";

/**
 * Search engine policy. Devnet/localhost builds must stay out of search
 * results (nobody should land on a test build of a wallet tool). Indexing is
 * gated on the same network env var as the app itself, so switching to
 * mainnet unlocks it automatically.
 */
export default function robots(): MetadataRoute.Robots {
  if (IS_MAINNET) {
    return {
      rules: { userAgent: "*", allow: "/" },
    };
  }
  return {
    rules: { userAgent: "*", disallow: "/" },
  };
}
