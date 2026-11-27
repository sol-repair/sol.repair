// @vitest-environment jsdom

/**
 * The mint and freeze authority display (the display spec Rev 1,
 * section 4, whose exact strings are approved and frozen).
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
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import type { ReactNode } from "react";
import type { ScanResult, SkippedAccount } from "@/lib/solana/tokenAccounts";

import { summarizeWalletState } from "@/lib/solana/walletInspection";
import { WalletStateSummary } from "@/components/WalletStateSummary";

afterEach(cleanup);

// Pinned display fixtures (owner order 2026-11-27, flaky-sweep fix).// The writing-rules sweeps below assert the banned-word regex against
// rendered text that includes these addresses; Keypair.generate() made
// the tests themselves flaky - a random base58 address occasionally
// carries a banned substring (demonstrated mechanically: the regex
// flagged "bUY" in a random candidate after 1,591 draws), and the
// sweep then flags the test's own fixture. Every pinned address is a
// real 32-byte public key, derived from a fixed seed and verified
// clean against the sweeps' regex in full and short form; the
// cleanliness pin is itself a test below, so fixture and sweep cannot
// drift apart. Receipt: .verify-tmp/post-merge/gen-pinned-addresses.mjs
const WRITING_RULES = /scam|risky|verdict|score|buy|sell/i;
const MINT_AUTHORITY = "6sVrhQF9aQ8uKoRivSMgqH6q5wGM7KRkhWgrHDqtwYFu";
const FREEZE_AUTHORITY = "D1hcSGfvvqVLG3oHHJxLSVs57i42mhzgW1xDktUmoLLd";
const MINT = "5zErA4Nib6bjfUqJCvXWQRtS2rg1HAQY2ge3EMVnEcof";
const CLOSE_AUTHORITY = "H7b3ths1gsh8j9wfno763upB78ov1RwqwyitmbNsdRBA";
const WALLET_KEY = new PublicKey("EviwLTeA8grkzLM53xE1VPMaNXgXiVFsX1SBzCiWFUWs");
const FROZEN_ROW_PUBKEY = "A4ApsW4dsYmZGiVbBKSgVe8b4zEK4fXjn9hH3utgScH5";
const REDESIGNED_ROW_PUBKEY = "Zf8FxRKrq5wWLeDFFfn4RrafwiNYbr62Hjdrmo2RDee";

describe("the pinned fixture addresses stay clean for the writing-rules sweeps", () => {
  const pinned: Array<[string, string]> = [
    ["MINT_AUTHORITY", MINT_AUTHORITY],
    ["FREEZE_AUTHORITY", FREEZE_AUTHORITY],
    ["MINT", MINT],
    ["CLOSE_AUTHORITY", CLOSE_AUTHORITY],
    ["FROZEN_ROW_PUBKEY", FROZEN_ROW_PUBKEY],
    ["REDESIGNED_ROW_PUBKEY", REDESIGNED_ROW_PUBKEY],
  ];

  it("every pinned address is a real 32-byte public key", () => {
    for (const [name, value] of pinned) {
      const bytes = new PublicKey(value).toBytes();
      expect(bytes, name).toHaveLength(32);
      expect(new PublicKey(bytes).toBase58(), name).toBe(value);
    }
    expect(WALLET_KEY.toBytes()).toHaveLength(32);
    expect(new PublicKey(WALLET_KEY.toBytes()).equals(WALLET_KEY)).toBe(true);
  });

  it("no pinned address carries a banned writing-rules substring", () => {
    // A clean full address implies a clean short form: the short form is
    // a substring window of the full one, and a banned match inside the
    // window would be a match inside the full address too.
    for (const [name, value] of pinned) {
      expect(value, name).not.toMatch(WRITING_RULES);
    }
    expect(WALLET_KEY.toBase58()).not.toMatch(WRITING_RULES);
  });

  it("the sweeps and the pin use the same regex object", () => {
    // Guard against drift: if the sweeps' banned-word list is ever
    // widened, this file's fixtures must be re-verified against the
    // widened list - which happens automatically because both read the
    // same constant.
    expect(WRITING_RULES.source).toBe("scam|risky|verdict|score|buy|sell");
    expect(WRITING_RULES.flags).toContain("i");
  });
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

  it("keeps the project writing rules on the rendered authority copy", () => {
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
    expect(text).not.toMatch(WRITING_RULES);
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
  mocks.wallet.publicKey = WALLET_KEY;
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
        pubkey: FROZEN_ROW_PUBKEY,
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

describe("the frozen funded row (the approved redesign)", () => {
  it("leads with Frozen. and shows the unfreeze authority with a link when the mint was readable", async () => {
    await renderHomeWithScan(
      frozenFundedSkip({
        freezeAuthorityActive: true,
        freezeAuthority: FREEZE_AUTHORITY,
      })
    );
    expect(screen.getAllByText("Frozen.").length).toBe(1);
    expect(
      screen.getAllByText(
        "Only the token\u2019s freeze authority can unfreeze it:"
      ).length
    ).toBe(1);
    // The authority appears on both deliberate surfaces of the frozen
    // row: the facts line and the sentence. Two links is the design.
    expect(screen.getAllByTitle(FREEZE_AUTHORITY).length).toBe(2);
  });

  it("renders the nobody-can-unfreeze sentence when the token revoked its freeze authority", async () => {
    const { container } = await renderHomeWithScan(
      frozenFundedSkip({ freezeAuthorityActive: false })
    );
    expect(
      screen.getAllByText(
        "Its token has no freeze authority anymore, so nothing can unfreeze it."
      ).length
    ).toBe(1);
    expect(screen.queryByTitle(FREEZE_AUTHORITY)).toBeNull();
  });

  it("renders the Frozen. lead-in without a link when the mint was unreadable", async () => {
    const { container } = await renderHomeWithScan(frozenFundedSkip({}));
    expect(screen.getAllByText("Frozen.").length).toBe(1);
    // No link, no dangling colon: the sentence closes with a period
    // when there is no authority to name (the audit's F10 fix).
    expect(
      screen.getAllByText(
        "Only the token\u2019s freeze authority can unfreeze it."
      ).length
    ).toBe(1);
    expect(screen.queryByTitle(FREEZE_AUTHORITY)).toBeNull();
  });

  it("suppresses the duplicated frozen reason on the redesigned row", async () => {
    const { container } = await renderHomeWithScan(
      frozenFundedSkip({
        freezeAuthorityActive: true,
        freezeAuthority: FREEZE_AUTHORITY,
      })
    );
    expect(container.textContent).not.toContain(
      "is frozen by the token's freeze authority"
    );
  });

  it("renders no frozen treatment on funded rows that are not frozen", async () => {
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
    expect(screen.queryByText("Frozen.")).toBeNull();
  });

  it("adds no score, verdict, or pre-trade framing on the frozen row", async () => {
    await renderHomeWithScan(
      frozenFundedSkip({
        freezeAuthorityActive: true,
        freezeAuthority: FREEZE_AUTHORITY,
      })
    );
    const lead = screen.getByText("Frozen.");
    const row = lead.closest("div");
    const text = row?.textContent ?? "";
    expect(text).not.toMatch(WRITING_RULES);
  });
});

describe("the redesigned scan rows carry labels and authority facts", () => {
  it("labels the account and mint and shows the recoverable amount on eligible rows", async () => {
    await renderHomeWithScan(
      scan({
        totalAccounts: 1,
        eligibleAccounts: [
          {
            pubkey: Keypair.generate().publicKey.toBase58(),
            mint: MINT,
            lamports: 2039280,
            program: "spl",
          },
        ],
        recoverableLamports: 2039280n,
      })
    );
    expect(screen.getAllByText("Account").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Mint").length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText(/recovers 0\.002039 SOL/).length
    ).toBeGreaterThanOrEqual(1);
  });

  it("shows the authority facts with labels on funded skip rows", async () => {
    const { container } = await renderHomeWithScan(
      scan({
        totalAccounts: 1,
        skippedAccounts: [
          skip({
            cause: "funded",
            reason: "holds a token balance",
            balance: "100",
            mintAuthorityActive: true,
            mintAuthority: MINT_AUTHORITY,
            freezeAuthorityActive: false,
          }),
        ],
      })
    );
    expect(container.textContent).toContain("Mint authority: active");
    expect(container.textContent).toContain("Freeze authority: none");
    // The reason stays on non-frozen rows.
    expect(container.textContent).toContain("holds a token balance");
  });

  it("keeps the project writing rules on the redesigned rows", async () => {
    const { container } = await renderHomeWithScan(
      scan({
        totalAccounts: 2,
        eligibleAccounts: [
          {
            pubkey: REDESIGNED_ROW_PUBKEY,
            mint: MINT,
            lamports: 2039280,
            program: "spl",
          },
        ],
        skippedAccounts: [
          skip({
            cause: "funded",
            reason: "holds a token balance",
            balance: "100",
            mintAuthorityActive: false,
            freezeAuthorityActive: false,
          }),
        ],
        recoverableLamports: 2039280n,
      })
    );
    const text = container.textContent ?? "";
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(text.includes("!")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text).not.toMatch(WRITING_RULES);
  });
});

describe("the home token cards permanent delegate fact", () => {
  const PERM_DELEGATE = Keypair.generate().publicKey.toBase58();

  it("shows the permanent delegate on funded skip rows with the mint-level qualifier", async () => {
    const { container } = await renderHomeWithScan(
      scan({
        totalAccounts: 1,
        skippedAccounts: [
          skip({
            pubkey: Keypair.generate().publicKey.toBase58(),
            mint: MINT,
            cause: "funded",
            reason: "holds a token balance",
            balance: "100",
            decimals: 6,
            lamports: 2039280,
            permanentDelegate: PERM_DELEGATE,
          }),
        ],
      })
    );
    expect(container.textContent).toContain("Permanent delegate: active");
    expect(container.textContent).toContain(
      "a mint-level authority the account owner cannot revoke"
    );
    expect(screen.getAllByTitle(PERM_DELEGATE).length).toBeGreaterThanOrEqual(1);
  });

  it("shows no permanent delegate line when the mint carried none", async () => {
    const { container } = await renderHomeWithScan(
      scan({
        totalAccounts: 1,
        skippedAccounts: [
          skip({
            pubkey: Keypair.generate().publicKey.toBase58(),
            mint: MINT,
            cause: "funded",
            reason: "holds a token balance",
            balance: "100",
            decimals: 6,
            lamports: 2039280,
          }),
        ],
      })
    );
    expect(container.textContent).not.toContain("Permanent delegate");
  });
});
