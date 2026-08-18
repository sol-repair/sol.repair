# SOL.repair

Reclaim SOL from empty token accounts.

If you have used Solana for a while, you have probably racked up a bunch of
old token accounts from airdrops, swaps, and spam tokens. Every one of them
holds about 0.00204 SOL as rent, and you can't spend it until the account
gets closed.

This site finds those accounts in your wallet, shows you exactly how much
you can get back, and closes them in one or a few quick transactions that
you approve in your own wallet.

## What it is

A non-custodial web app. That means:

- It never touches your private keys or seed phrase.
- It never holds your funds.
- It builds a transaction and your wallet shows you what it does. You sign
  it or you don't. Nothing happens without your approval.
- The transaction closes your empty token accounts and sends the rent
  straight back to your own wallet.
- There is a 1% success fee on what you recover. It is a transfer to the
  published fee address inside the same transaction, visible in your wallet
  before you approve. It pays for keeping this thing running.

The code that builds the transaction is right here. Read it. If you don't
trust it, don't use it.

## What it is not

- Not a swap tool. It doesn't trade your tokens for anything.
- Not a custody service. It never has your money, so there is nothing to
  run off with.
- Not financial advice. It's a utility that runs one specific on-chain
  operation and nothing else.

## What gets closed

Token accounts (classic SPL Token and Token-2022) that pass all of these:

1. Zero token balance. If an account holds any tokens at all, it gets left
   alone. The app enforces this and so does the Solana program, so it's
   checked twice.
2. Not actively delegated.
3. Close authority still with your wallet. Some accounts created by other
   programs can only be closed by those programs, so they are skipped.
4. Not wrapped SOL.
5. In the "initialized" state.

Fail any one of those and the account is skipped, no exceptions. NFTs and
any account holding tokens are protected by the zero-balance rule.

## Running it locally

Node.js 20 or newer.

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

The app defaults to Solana devnet and the UI shows DEVNET right on it so
you can't mistake it for mainnet. Mainnet is an explicit config change, not
the default.

## Tech stack

Next.js (App Router), TypeScript, Tailwind CSS, @solana/web3.js v1, and the
@solana/wallet-adapter-react suite.

Why web3.js v1 instead of v2: v2 is Anza's current recommendation, but the
wallet adapter libraries haven't fully caught up to it yet (see the open
compatibility issues). Wallet compatibility is part of the security of this
app, so v1 is the lower-risk choice right now. The Solana-specific code is
isolated under src/lib/solana/, so moving to v2 later won't mean a rewrite.

## Layout

```
src/app/         Next.js App Router pages and layout
src/components/  UI components (wallet button, network badge)
src/hooks/       React hooks for the scan and repair flow
src/lib/solana/  Solana domain logic: scanning, eligibility, transactions
```

## Security model

- Non-custodial. The app never has access to your private keys.
- Transactions are built in the browser and signed in your wallet. The app
  can't sign on your behalf.
- Wallet addresses are never read from URLs or query parameters. Only the
  connected wallet's public key is used.
- Recovered SOL always goes back to the connected wallet.

Found a security issue? Email admin@sol.repair with the details. Please
don't open a public issue for security problems.

## License

MIT. See LICENSE. The software is provided as-is, with no warranty. Using
it is at your own risk.

## Status

Live at https://sol.repair on Solana mainnet. There is a 1% success fee
on recovered SOL, taken as a transfer inside the repair transaction, so
it is always visible in your wallet before you approve. Details in the
Terms of Service on the site.
