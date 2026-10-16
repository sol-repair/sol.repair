// @vitest-environment jsdom

/**
 * Component tests for the wallet state inspection summary (G.1).
 *
 * The component is presentation-only: it renders an already-computed
 * WalletInspectionSummary. These tests pin the information hierarchy, the
 * scoped no-findings statement (which must NOT claim the wallet is
 * "clean"), the incomplete/unreadable line, and the read-only boundary
 * (the component and the summarizer import no wallet-adapter or
 * action-bearing module).
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

import {
  summarizeWalletState,
} from "@/lib/solana/walletInspection";
import { WalletStateSummary } from "@/components/WalletStateSummary";
import type {
  ClosableAccount,
  ScanResult,
  SkippedAccount,
} from "@/lib/solana/tokenAccounts";

const account = (over: Partial<ClosableAccount> = {}): ClosableAccount => ({
  pubkey: "ACCT",
  mint: "MINT",
  lamports: 2039280,
  program: "spl",
  ...over,
});

const skip = (
  over: Partial<SkippedAccount> & { cause: SkippedAccount["cause"] }
): SkippedAccount => ({
  pubkey: "SKIP",
  mint: "MINT",
  reason: "reason text",
  program: "spl",
  ...over,
});

const scan = (over: Partial<ScanResult> = {}): ScanResult => ({
  totalAccounts: 0,
  eligibleAccounts: [],
  recoverableLamports: 0n,
  skippedAccounts: [],
  ...over,
});

afterEach(cleanup);

describe("WalletStateSummary", () => {
  it("renders the finding lines and scope statement for a mixed scan", () => {
    const summary = summarizeWalletState(
      scan({
        totalAccounts: 4,
        eligibleAccounts: [account(), account({ needsRevoke: true })],
        recoverableLamports: 4078560n,
        skippedAccounts: [
          skip({
            pubkey: "S1",
            cause: "funded",
            reason: "holds a token balance",
            balance: "7",
            decimals: 6,
            lamports: 200,
            delegated: true,
          }),
          skip({ pubkey: "S2", cause: "unreadable" }),
        ],
      })
    );
    render(<WalletStateSummary summary={summary} />);
    expect(screen.getByText(/Inspected 4 token accounts/)).toBeTruthy();
    // "finalized view" appears in both the header and the scope footer.
    expect(screen.getAllByText(/finalized view/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/2 empty accounts/)).toBeTruthy();
    expect(screen.getByText(/1 account holds tokens/)).toBeTruthy();
    expect(screen.getByText(/2 standing delegations/)).toBeTruthy();
    expect(screen.getByText(/could not be read/)).toBeTruthy();
    expect(screen.getByText(/Not checked: your SOL balance/)).toBeTruthy();
  });

  it("renders only the lines whose count is greater than zero", () => {
    const summary = summarizeWalletState(
      scan({
        totalAccounts: 1,
        eligibleAccounts: [account()],
        recoverableLamports: 2039280n,
      })
    );
    const { container } = render(<WalletStateSummary summary={summary} />);
    expect(container.textContent).toMatch(/1 empty account,/);
    expect(container.textContent).not.toMatch(/hold tokens/);
    expect(container.textContent).not.toMatch(/standing delegation/);
    expect(container.textContent).not.toMatch(/could not be read/);
  });

  it("states the scoped no-findings position and never claims the wallet is clean", () => {
    const summary = summarizeWalletState(scan());
    const { container } = render(<WalletStateSummary summary={summary} />);
    expect(container.textContent).toMatch(/No token accounts were found\./);
    expect(container.textContent).toMatch(/Checked: token accounts owned by this wallet/);
    expect(container.textContent).toMatch(/Not checked: your SOL balance/);
    expect(container.textContent).not.toMatch(/clean/i);
  });

  it("keeps the unreadable line visible when the scan is incomplete", () => {
    const summary = summarizeWalletState(
      scan({
        totalAccounts: 1,
        skippedAccounts: [
          skip({
            pubkey: "S1",
            cause: "unreadable",
            reason: "response could not be read (malformed RPC data)",
          }),
        ],
      })
    );
    render(<WalletStateSummary summary={summary} />);
    expect(screen.getByText(/1 account could not be read/)).toBeTruthy();
    expect(screen.getByText(/shown in the skipped list/)).toBeTruthy();
  });

  it("clarifies that an empty frozen account can still be closed", () => {
    // Owner-approved 2026-09-25: frozen delegated accounts are eligible
    // close-only, so the frozen line must not read as a dead end.
    const summary = summarizeWalletState(
      scan({
        totalAccounts: 1,
        eligibleAccounts: [account({ frozen: true })],
      })
    );
    render(<WalletStateSummary summary={summary} />);
    expect(screen.getByText(/1 frozen account/)).toBeTruthy();
    expect(
      screen.getByText(/An empty frozen account can still be closed\./)
    ).toBeTruthy();
  });

  it("groups the close-authority skips by address behind a collapsed list", () => {
    const authorityA = Keypair.generate().publicKey.toBase58();
    const authorityB = Keypair.generate().publicKey.toBase58();
    const authorityC = Keypair.generate().publicKey.toBase58();
    const caSkip = (pubkey: string, closeAuthority: string) =>
      skip({
        pubkey,
        cause: "close-authority",
        reason: "close authority belongs to another address",
        closeAuthority,
      });
    const summary = summarizeWalletState(
      scan({
        totalAccounts: 6,
        skippedAccounts: [
          caSkip("S1", authorityA),
          caSkip("S2", authorityA),
          caSkip("S3", authorityB),
          caSkip("S4", authorityC),
          caSkip("S5", authorityC),
          caSkip("S6", authorityC),
        ],
      })
    );
    const { container } = render(<WalletStateSummary summary={summary} />);
    // The existing count sentence is unchanged.
    expect(container.textContent).toMatch(
      /6 accounts name a close authority other than this wallet\./
    );
    expect(screen.getByText("Who holds those authorities")).toBeTruthy();
    // Rows sort by count descending: C (3), then A (2), then B (1).
    const text = container.textContent ?? "";
    const cAt = text.indexOf("can close 3 of these accounts.");
    const aAt = text.indexOf("can close 2 of these accounts.");
    const bAt = text.indexOf("can close 1 of these accounts.");
    expect(cAt).toBeGreaterThan(-1);
    expect(aAt).toBeGreaterThan(cAt);
    expect(bAt).toBeGreaterThan(aAt);
    // The anchor's title carries the FULL base58 address and links to
    // Solscan with the cluster param of the network default (devnet in
    // the test environment).
    const link = container.querySelector(`a[title="${authorityC}"]`);
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe(
      `https://solscan.io/account/${authorityC}?cluster=devnet`
    );
    // With several authorities listed, the sentence must not claim one
    // single authority; and the list stays collapsed until opened.
    expect(container.textContent).toMatch(
      /Only the authority each account names can close it\./
    );
    expect(link?.closest("details")?.open).toBe(false);
  });

  it("names the funded accounts carrying a foreign close authority (plural)", () => {
    const authority = Keypair.generate().publicKey.toBase58();
    const fundedForeign = () =>
      skip({
        cause: "funded",
        reason: "holds a token balance",
        balance: "5",
        lamports: 1,
        foreignCloseAuthority: true,
        closeAuthority: authority,
      });
    const summary = summarizeWalletState(
      scan({
        totalAccounts: 2,
        skippedAccounts: [fundedForeign(), fundedForeign()],
      })
    );
    const { container } = render(<WalletStateSummary summary={summary} />);
    expect(container.textContent).toMatch(
      /2 funded accounts name a close authority other than this wallet\. They are counted above with the accounts holding tokens\./
    );
    expect(
      screen.getByText("Who holds the authorities on the funded accounts")
    ).toBeTruthy();
    expect(container.textContent).toMatch(
      /is the close authority on 2 funded accounts\./
    );
  });

  it("names a single funded account carrying a foreign close authority (singular)", () => {
    const authority = Keypair.generate().publicKey.toBase58();
    const summary = summarizeWalletState(
      scan({
        totalAccounts: 1,
        skippedAccounts: [
          skip({
            cause: "funded",
            reason: "holds a token balance",
            balance: "5",
            lamports: 1,
            foreignCloseAuthority: true,
            closeAuthority: authority,
          }),
        ],
      })
    );
    const { container } = render(<WalletStateSummary summary={summary} />);
    expect(container.textContent).toMatch(
      /1 funded account names a close authority other than this wallet\. It is counted above with the accounts holding tokens\./
    );
    expect(container.textContent).toMatch(
      /is the close authority on 1 funded account\./
    );
  });

  it("renders no authority lists or funded line when the counts are zero", () => {
    const summary = summarizeWalletState(
      scan({
        totalAccounts: 1,
        eligibleAccounts: [account()],
        recoverableLamports: 2039280n,
      })
    );
    const { container } = render(<WalletStateSummary summary={summary} />);
    expect(container.textContent).not.toMatch(/Who holds those authorities/);
    expect(container.textContent).not.toMatch(
      /Who holds the authorities on the funded accounts/
    );
    expect(container.textContent).not.toMatch(
      /counted above with the accounts holding tokens/
    );
  });

  it("keeps the writing rules on a render with all the new copy", () => {
    // Both summary toggles, both row forms, and the missing-value rows
    // (the entries without an address are hand-built; the scan always
    // records it at the skip site) all land in one render.
    const authority = Keypair.generate().publicKey.toBase58();
    const summary = summarizeWalletState(
      scan({
        totalAccounts: 5,
        skippedAccounts: [
          skip({ pubkey: "S1", cause: "close-authority", closeAuthority: authority }),
          skip({ pubkey: "S2", cause: "close-authority", closeAuthority: authority }),
          skip({ pubkey: "S3", cause: "close-authority" }),
          skip({
            pubkey: "S4",
            cause: "funded",
            balance: "5",
            lamports: 1,
            foreignCloseAuthority: true,
            closeAuthority: authority,
          }),
          skip({
            pubkey: "S5",
            cause: "funded",
            balance: "5",
            lamports: 1,
            foreignCloseAuthority: true,
          }),
        ],
      })
    );
    const { container } = render(<WalletStateSummary summary={summary} />);
    const text = container.textContent ?? "";
    for (const phrase of [
      "Who holds those authorities",
      "Who holds the authorities on the funded accounts",
      "can close 2 of these accounts.",
      "is the close authority on 1 funded account.",
      "authority not recorded on 1 of these accounts",
      "2 funded accounts name a close authority other than this wallet.",
    ]) {
      expect(text).toContain(phrase);
    }
    expect(text).not.toMatch(/[\u2014\u2013]/);
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(text).not.toMatch(/!/);
  });

  it("imports no wallet adapter and no action-bearing module (read-only boundary)", () => {
    // Match whole import statements (multi-line imports included), so
    // boundary prose naming the banned modules cannot trip the check.
    const importStatements = (source: string) =>
      source.match(/^import[\s\S]*?from "[^"]+";/gm) ?? [];
    const componentImports = importStatements(
      readFileSync("src/components/WalletStateSummary.tsx", "utf8")
    );
    expect(componentImports.length).toBeGreaterThanOrEqual(1);
    expect(componentImports.join("\n")).not.toMatch(
      /wallet-adapter|useRepairWallet|solana\/(closeAccounts|fees|transactions)/
    );
    const summarizerImports = importStatements(
      readFileSync("src/lib/solana/walletInspection.ts", "utf8")
    );
    // Exactly one import: the tokenAccounts types. Nothing else.
    expect(summarizerImports).toHaveLength(1);
    expect(summarizerImports[0]).toMatch(/\.\/tokenAccounts/);
    expect(summarizerImports[0]).not.toMatch(/react/i);
  });

  it("retires the overclaiming no-findings copy from the homepage", () => {
    const page = readFileSync("src/app/page.tsx", "utf8");
    expect(page).not.toMatch(/already clean/);
  });
});
