# Security Policy

## Supported version

The `main` branch, deployed at sol.repair, is the only supported version.

## Reporting a vulnerability

Open a private security advisory through this repository's Security tab.
Only open a public issue when the detail is safe to disclose. Including the
transaction signature or page involved makes a report much easier to act on.

## What the app is

The site is fully client-side. There is no backend and no server-side state:
the browser reads the chain directly through public RPC endpoints, the fee
ledger is derived from on-chain transactions in the visitor's own browser,
and the site never receives private keys or seed phrases. Every transaction
is signed by the user in their own wallet.

## Dependency risk posture

Reviewed 2026-09-11.

Automated scanners flag advisories in two places, and both are documented
here rather than hidden:

1. **The Solana ecosystem toolchain** (`@solana/web3.js` 1.x, the
   `@solana/wallet-adapter-*` packages, the `@solana/spl-token-*` family,
   and `bigint-buffer` beneath them). For each of these, either no patched
   release exists upstream or the only available fix is a breaking downgrade
   of the runtime toolchain. The flagged parser paths exist to decode bytes
   the library itself did not originate; this app feeds them only responses
   from its own configured RPC endpoints and transactions it built locally,
   so no attacker-controlled input reaches them. Accepted until the upstream
   libraries ship compatible patches.

2. **Dev-only build chains** (react-native → metro → image-size, pulled in
   transitively by the mobile wallet adapter package). These run at
   development time on the maintainer's machine and are never part of the
   deployed site. Some carry advisories with no patched release at all
   (the `image-size` advisories cover the latest published version).
   Accepted, and re-checked on dependency updates.

Patched, in-range advisories are taken promptly with targeted lockfile
updates. Blanket `npm audit fix` is deliberately not used: it has historically
proposed forcing breaking downgrades of the runtime Solana toolchain.
