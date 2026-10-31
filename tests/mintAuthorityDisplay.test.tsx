// @vitest-environment jsdom

/**
 * The mint and freeze authority display (the display spec Rev 1,
 * section 4, whose exact strings are owner-approved and frozen).
 *
 * Two render surfaces, both pre-existing:
 *  - the mint lines under the grouped authority lists in
 *    WalletStateSummary, which gain the mint authority and freeze
 *    authority states after the mint link and self-declared name;
 *  - the frozen funded rows in the homepage skipped list, which gain
 *    the one frozen sentence, with the freeze authority link when the
 *    mint was readable and without one when it was not.
 *
 * Presentation only: the strings below are asserted byte-exact, no
 * score or verdict may appear, and the existing label and guidance
 * blocks stay unchanged.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Keypair, type Connection, type PublicKey } from "@solana/web3.js";
import type { ReactNode } from "react";
import type { ScanResult, SkippedAccount } from "@/lib/solana/tokenAccounts";

import { summarizeWalletState } from "@/lib/solana/walletInspection";
import { WalletStateSummary } from "@/components/WalletStateSummary";

afterEach(cleanup);

const MINT_AUTHORITY = Keypair.generate().publicKey.toBase58();
const FREEZE_AUTHORITY = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();
const CLOSE_AUTHORITY = Keypair.generate().publicKey.toBase58();

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

/** Render a summary whose only finding is one foreign-close-authority
 *  skip carrying the given mint evidence. */
function renderForeignCA(entry: Partial<SkippedAccount>) {
  const summary = summarizeWalletState(
    scan({
      totalAccounts: 1,
      skippedAccounts: [
        skip({
          cause: "close-authority",
          reason: "close authority belongs to another address",
          closeAuthority: CLOSE_AUTHORITY,
          mint: MINT,
          ...entry,
        }),
      ],
    })
  );
  return render(<WalletStateSummary summary={summary} />);
}

describe("mint lines carry the authority states", () => {
  it("renders active authorities with the exact copy and authority links", () => {
    renderForeignCA({
      mintAuthorityActive: true,
      mintAuthority: MINT_AUTHORITY,
      freezeAuthorityActive: true,
      freezeAuthority: FREEZE_AUTHORITY,
    });
    expect(screen.getAllByText(/mint authority: active/).length).toBe(1);
    expect(screen.getAllByText(/freeze authority: active/).length).toBe(1);
    // The authority links carry the full address in the tooltip and
    // show the short form, same as every other account link.
    const mintLink = screen.getAllByTitle(MINT_AUTHORITY);
    expect(mintLink.length).toBeGreaterThanOrEqual(1);
    const freezeLink = screen.getAllByTitle(FREEZE_AUTHORITY);
    expect(freezeLink.length).toBeGreaterThanOrEqual(1);
  });

  it("renders revoked mint authority and absent freeze authority without links", () => {
    const { container } = renderForeignCA({
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
    });
    expect(container.textContent).toContain("mint authority: revoked");
    expect(container.textContent).toContain("freeze authority: none");
    expect(container.textContent).not.toContain("mint authority: active");
    expect(container.textContent).not.toContain("freeze authority: active");
    expect(screen.queryByTitle(MINT_AUTHORITY)).toBeNull();
    expect(screen.queryByTitle(FREEZE_AUTHORITY)).toBeNull();
  });

  it("renders no authority text when the mint was unreadable", () => {
    const { container } = renderForeignCA({});
    expect(container.textContent).not.toContain("mint authority:");
    expect(container.textContent).not.toContain("freeze authority:");
  });

  it("keeps the owner writing rules on the rendered authority copy", () => {
    const { container } = renderForeignCA({
      mintAuthorityActive: true,
      mintAuthority: MINT_AUTHORITY,
      freezeAuthorityActive: true,
      freezeAuthority: FREEZE_AUTHORITY,
    });
    const text = container.textContent ?? "";
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(text.includes("!")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text).not.toMatch(/scam|safe|risky|verdict|score/i);
  });
});

const mocks = vi.hoisted(() => ({
  wallet: {
    publicKey: null as PublicKey | null,
    wallet: null,
    wallets: [] as unknown[],
    connect: vi.fn(),
    disconnect: vi.fn(),
    connecting: false,
    connected: true,
    select: vi.fn(),
  },
  scan: {
    loading: false,
    result: null as ScanResult | null,
    error: null as string | null,
    rescan: vi.fn(),
  },
  repair: {
    status: "idle" as string,
    signature: null as string | null,
    signatures: [] as string[],
    closedCount: 0,
    recoveredLamports: 0n,
    progress: null as { current: number; total: number } | null,
    error: null as string | null,
    errorDetail: null as string | null,
    repair: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.wallet,
  useConnection: () => ({ connection: {} as Connection }),
  ConnectionProvider: ({ children }: { children?: ReactNode }) =>
    children as ReactNode,
  WalletProvider: ({ children }: { children?: ReactNode }) =>
    children as ReactNode,
}));

vi.mock("@/hooks/useWalletScan", () => ({
  useWalletScan: () => mocks.scan,
}));

vi.mock("@/hooks/useRepairWallet", async () => ({
  useRepairWallet: () => mocks.repair,
  MAX_ACCOUNTS_PER_RUN: (
    await vi.importActual<typeof import("@/hooks/useRepairWallet")>(
      "@/hooks/useRepairWallet"
    )
  ).MAX_ACCOUNTS_PER_RUN,
}));

vi.mock("next/link", () => ({
  default: (props: { href: string; children?: ReactNode }) => (
    <a href={props.href}>{props.children}</a>
  ),
}));

// The homepage reaches the wallet UI through next/dynamic behind the
// connect boundary; the connect controls and wallet-picker imports are
// not under test here.
vi.mock("@/components/WalletButton", () => ({
  WalletButton: () => null,
}));

const HOME = () => import("../src/app/page");

async function renderHomeWithScan(result: ScanResult | null) {
  mocks.wallet.publicKey = Keypair.generate().publicKey;
  mocks.scan.result = result;
  mocks.scan.loading = false;
  mocks.scan.error = null;
  const { default: Home } = await HOME();
  const { renderHome } = await import("./renderHome");
  return renderHome(<Home />);
}

/** One frozen funded skip with the given evidence fields. */
function frozenFundedSkip(
  evidence: Partial<SkippedAccount>
): ScanResult {
  return scan({
    totalAccounts: 1,
    skippedAccounts: [
      skip({
        pubkey: Keypair.generate().publicKey.toBase58(),
        mint: MINT,
        cause: "funded",
        reason: "is frozen by the token's freeze authority",
        balance: "100",
        decimals: 6,
        lamports: 2039280,
        frozen: true,
        ...evidence,
      }),
    ],
  });
}

describe("the frozen funded row sentence", () => {
  it("appends the exact sentence with the freeze authority link when the mint was readable", async () => {
    await renderHomeWithScan(
      frozenFundedSkip({
        freezeAuthorityActive: true,
        freezeAuthority: FREEZE_AUTHORITY,
      })
    );
    expect(
      screen.getAllByText(
        "This account is frozen. Only the token's freeze authority can unfreeze it."
      ).length
    ).toBe(1);
    expect(screen.getAllByTitle(FREEZE_AUTHORITY).length).toBe(1);
  });

  it("renders the sentence without a link when the mint was unreadable", async () => {
    const { container } = await renderHomeWithScan(frozenFundedSkip({}));
    expect(
      screen.getAllByText(
        "This account is frozen. Only the token's freeze authority can unfreeze it."
      ).length
    ).toBe(1);
    expect(screen.queryByTitle(FREEZE_AUTHORITY)).toBeNull();
    // Nothing else is added beyond the sentence.
    expect(container.textContent).not.toContain("freeze authority:");
  });

  it("renders no sentence on funded rows that are not frozen", async () => {
    await renderHomeWithScan(
      scan({
        totalAccounts: 1,
        skippedAccounts: [
          skip({
            cause: "funded",
            reason: "holds a token balance",
            balance: "100",
          }),
        ],
      })
    );
    expect(
      screen.queryByText(
        "This account is frozen. Only the token's freeze authority can unfreeze it."
      )
    ).toBeNull();
  });

  it("adds no score, verdict, or pre-trade framing on the frozen row", async () => {
    await renderHomeWithScan(
      frozenFundedSkip({
        freezeAuthorityActive: true,
        freezeAuthority: FREEZE_AUTHORITY,
      })
    );
    // Scope the check to the row that carries the new sentence: the
    // page's own long-standing copy is not this spec's surface.
    const sentence = screen.getByText(
      "This account is frozen. Only the token's freeze authority can unfreeze it."
    );
    const row = sentence.closest("div");
    const text = row?.textContent ?? "";
    expect(text).not.toMatch(/scam|risky|verdict|score|buy|sell/i);
  });
});
