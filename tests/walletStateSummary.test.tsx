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
