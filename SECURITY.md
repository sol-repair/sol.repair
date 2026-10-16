# Security Policy

## Supported version

The `main` branch, deployed at sol.repair, is the only supported version.

## Reporting a vulnerability

Open a private security advisory through this repository's Security tab.
Only open a public issue when the detail is safe to disclose. Including the
transaction signature or page involved makes a report much easier to act on.

## What the app is

The site is fully client-side. There is no backend and no server-side state:
the browser reads the chain directly through its configured ordered RPC
endpoint list (provider endpoints first, public cluster endpoints as
fallback), the fee ledger is derived from on-chain transactions in the
visitor's own browser, and the site never receives private keys or seed
phrases. Every transaction is signed by the user in their own wallet.

## Dependency risk posture

Reviewed 2026-10-16 (previous review 2026-09-11).

### Patched on 2026-10-16

- `next` 16.3.4 -> 16.3.8: GHSA-vcvr-r3jv-pc5j (critical; code execution
  in `next/og` ImageResponse - this site's only use renders a static,
  hardcoded card at build time with no visitor input) and
  GHSA-3w37-wq28-93x7 (medium; use-cache draft-mode leak - the site uses
  neither feature).
- `shell-quote` override `^1.11.0`: GHSA-pqg4-j6r4-53mv (critical).
  Reached only through the wallet-adapter dev-tool chain
  (`react-native` -> `react-devtools-core`), never part of the deployed
  site. The override mirrors the earlier `image-size` pattern.
- In-range lockfile updates, no forcing needed: `sharp` 0.35.5
  (GHSA-wq5f-xc86-pv6w), `source-map-js` 1.2.2 (GHSA-68fv-2mgg-jv7q),
  `brace-expansion` 1.1.21 and 5.0.12 (GHSA-q2hr-2g5m-vwhr). Each fixed
  version already satisfied the range its parent package declares.

### Accepted risks

Automated scanners still flag advisories in two places, and both are
documented here rather than hidden. Each corresponding dismissal on the
repository Security tab carries the same rationale:

1. **The Solana ecosystem toolchain** (`@solana/web3.js` 1.x, the
   `@solana/wallet-adapter-*` packages, the `@solana/spl-token-*` family,
   and `bigint-buffer` and `stream-json` beneath them). For each of
   these, either no patched release exists upstream or the only
   available fix is a breaking downgrade of the runtime toolchain. The
   flagged parser paths exist to decode bytes the library itself did not
   originate; this app feeds them only responses from its own configured
   RPC endpoints and transactions it built locally, so no
   attacker-controlled input reaches them. `stream-json`
   (GHSA-hqr4-qq8f-hg3x, GHSA-mjw6-4jj6-33hc, beneath
   `@solana/web3.js` -> `jayson` 4.3.0) is the clearest case: the fixed
   3.6.0 is two major versions outside jayson's declared range, so
   installing it would break the library's own dependency contract on
   the wallet RPC path. An RPC response is still external input: a
   hostile or compromised configured endpoint could trigger slow parsing
   (CPU burn in the visitor's tab; no code execution, no data exposure).
   All of these are accepted until the upstream libraries ship
   compatible patches; the explicit revisit trigger for the
   `stream-json` pair is the planned migration to web3.js 2.x
   (`@solana/kit`), at which point this whole item is re-derived from
   the new dependency tree.

2. **Dev-only build chains** (react-native -> metro, pulled in
   transitively by the mobile wallet adapter package, and the lint
   tooling beneath `eslint-config-next`). These run at development time
   on the maintainer's machine or in CI and are never part of the
   deployed site. Some carry advisories with no patched release at all:
   the `image-size` advisories cover the latest published version, and
   `braces` (GHSA-vfj7-8cjw-p6xm, beneath `eslint-config-next` ->
   `@next/eslint-plugin-next` -> `fast-glob` -> `micromatch`) has no
   fixed version upstream as of this review; it parses only this
   repository's own static lint patterns. Accepted, and re-checked on
   every dependency update; each clears automatically if a patched
   release appears and fits the declared ranges.

Patched, in-range advisories are taken promptly with targeted lockfile
updates. Blanket `npm audit fix` is deliberately not used: it has historically
proposed forcing breaking downgrades of the runtime Solana toolchain.
