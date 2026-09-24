// @vitest-environment jsdom

/**
 * Component tests for DelegationSection (spec §10.4): the finding
 * rows, the per-item consent card, the balance-observation blocks
 * (§8.2 Cases A-D), the terminal-outcome cards (§8.9), the forbidden
 * phrasings (§6.3), and the repairInFlight affordance (§8.12).
 *
 * The hook is mocked: its behavior is pinned exhaustively in
 * tests/useRevokeDelegate.test.tsx. Here the hook's STATES are the
 * inputs and the rendered copy is what must be honest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  DelegationSection,
  balanceObservationCopy,
} from "../src/components/DelegationSection";
import { buildRevokeInstruction } from "../src/lib/solana/revokeDelegation";
import type { RevokeState } from "../src/hooks/useRevokeDelegate";
import type { ScanResult, SkippedAccount } from "../src/lib/solana/tokenAccounts";

const mocks = vi.hoisted(() => ({
  holder: { publicKey: null as PublicKey | null },
  conn: { getParsedAccountInfo: vi.fn() },
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.holder,
  useConnection: () => ({
    connection: mocks.conn as unknown as import("@solana/web3.js").Connection,
  }),
}));

vi.mock("@/hooks/useRevokeDelegate", () => ({
  useRevokeDelegate: vi.fn(),
}));

import { useRevokeDelegate } from "@/hooks/useRevokeDelegate";

const hookMock = vi.mocked(useRevokeDelegate);

const OWNER = Keypair.generate();
const TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const DELEGATE = Keypair.generate().publicKey.toBase58();

const idleState = (): RevokeState => ({
  status: "idle",
  outcome: null,
  signatures: [],
  accountPubkey: null,
  delegate: null,
  balanceAtScan: null,
  balanceBeforeAction: null,
  balanceAfterAction: null,
  delegatePresentAtLastRead: null,
  note: null,
  error: null,
  errorDetail: null,
});

const revoke = vi.fn();
const reset = vi.fn();

function setHook(over: Partial<RevokeState>, actionInFlight = false) {
  hookMock.mockReturnValue({
    ...idleState(),
    ...over,
    actionInFlight,
    revoke,
    reset,
  });
}

const eligibleEntry: SkippedAccount = {
  pubkey: Keypair.generate().publicKey.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  reason: "holds a token balance",
  program: "spl",
  cause: "funded",
  balance: "1000000",
  decimals: 6,
  lamports: 2039280,
  delegated: true,
  delegate: DELEGATE,
  nativeStatus: "non-native",
};

const frozenEntry: SkippedAccount = {
  pubkey: Keypair.generate().publicKey.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  reason: "is frozen by the token's freeze authority",
  program: "spl",
  cause: "funded",
  balance: "5",
  decimals: 6,
  lamports: 2039280,
  delegated: true,
  delegate: DELEGATE,
  frozen: true,
  nativeStatus: "non-native",
};

const scanWith = (skipped: SkippedAccount[]): ScanResult => ({
  totalAccounts: skipped.length,
  eligibleAccounts: [],
  recoverableLamports: 0n,
  skippedAccounts: skipped,
});

const parsedRead = (over: {
  delegate?: string | null;
  amount?: string;
  state?: string;
} = {}) => ({
  value: {
    lamports: 2039280,
    owner: TOKEN_PROGRAM,
    data: {
      parsed: {
        info: {
          mint: Keypair.generate().publicKey.toBase58(),
          owner: OWNER.publicKey.toBase58(),
          tokenAmount: {
            amount: over.amount ?? "1000000",
            decimals: 6,
            uiAmount: null,
            uiAmountString: "0",
          },
          ...(over.delegate === undefined
            ? { delegate: DELEGATE }
            : over.delegate === null
              ? {}
              : { delegate: over.delegate }),
          state: over.state ?? "initialized",
          isNative: false,
        },
      },
    },
  },
});

const BANNED: RegExp[] = [
  /compromised/i,
  /\bscam\b/i,
  /malicious/i,
  /\bunsafe\b/i,
  /at risk/i,
  /guarantee/i,
  /entire balance/i,
  /full balance/i,
  /all of your tokens/i,
  /balance unchanged/i,
  /balance is unchanged/i,
  /balance when last read/i,
  /the delegate acted/i,
  /delegate spent/i,
  /someone with authority moved/i,
  /undo what the delegate did/i,
];

function expectNoBannedPhrases() {
  const text = document.body.textContent ?? "";
  for (const banned of BANNED) {
    expect(text).not.toMatch(banned);
  }
}

async function openReviewCard() {
  mocks.conn.getParsedAccountInfo.mockResolvedValue(parsedRead());
  render(
    <DelegationSection
      scan={scanWith([eligibleEntry])}
      rescan={() => {}}
      repairInFlight={false}
    />
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Revoke delegate" })[0]);
  await screen.findByText("Review before you sign");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.holder.publicKey = OWNER.publicKey;
  setHook({});
});

afterEach(cleanup);

describe("finding rows (§6.2 block 1)", () => {
  it("renders eligible rows with account, mint, balance, delegate, and program", () => {
    render(
      <DelegationSection
        scan={scanWith([eligibleEntry])}
        rescan={() => {}}
        repairInFlight={false}
      />
    );
    expect(screen.getByText(/Standing delegations/)).toBeTruthy();
    expect(
      screen.getByText(/1 funded account with a balance has an active delegation/)
    ).toBeTruthy();
    expect(screen.getByText(/balance 1,000,000 base units/)).toBeTruthy();
    expect(screen.getByText(/\(6 decimals, at scan time\)/)).toBeTruthy();
    expect(screen.getAllByText(/delegate /).length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText(/Only accounts the scan could confirm as non-native/)
    ).toBeTruthy();
    expectNoBannedPhrases();
  });

  it("lists frozen delegated accounts read-only, with the frozen note", () => {
    render(
      <DelegationSection
        scan={scanWith([eligibleEntry, frozenEntry])}
        rescan={() => {}}
        repairInFlight={false}
      />
    );
    expect(
      screen.getByText(
        /frozen by the token.s freeze authority; a frozen account cannot be revoked/
      )
    ).toBeTruthy();
    // Exactly one actionable row.
    expect(
      screen.getAllByRole("button", { name: "Revoke delegate" })
    ).toHaveLength(1);
  });

  it("carries the delegate-permission wording without inventing an allowance (§6.4)", () => {
    const { container } = render(
      <DelegationSection
        scan={scanWith([eligibleEntry])}
        rescan={() => {}}
        repairInFlight={false}
      />
    );
    fireEvent.click(screen.getByText("What this delegation means"));
    const text = container.textContent ?? "";
    expect(text).toContain("The amount of delegated spending authority is not displayed");
    expect(text).toContain("by transferring or burning");
    expect(text).toContain("up to the delegated amount");
    expect(text).not.toMatch(new RegExp("allowance of [0-9]"));
    expectNoBannedPhrases();
  });
});

describe("the confirmation card (§6.2 block 4)", () => {
  it("shows both balance reads and the single-instruction claim", async () => {
    await openReviewCard();
    expect(
      screen.getByText(/Balance at scan: 1,000,000 base units\./)
    ).toBeTruthy();
    expect(
      screen.getByText(/Balance at the fresh read just now: 1,000,000 base units\./)
    ).toBeTruthy();
    expect(
      screen.getByText(/contains exactly one instruction: revoke, from the SPL Token Program/)
    ).toBeTruthy();
    expect(screen.getByText(/No service fee/)).toBeTruthy();
    expect(screen.getByText(/Network fee: ~/)).toBeTruthy();
    expectNoBannedPhrases();
  });

  it("states the balance drift without attributing it (Case B, §8.2)", async () => {
    mocks.conn.getParsedAccountInfo.mockResolvedValue(
      parsedRead({ amount: "900000" })
    );
    render(
      <DelegationSection
        scan={scanWith([eligibleEntry])}
        rescan={() => {}}
        repairInFlight={false}
      />
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke delegate" })[0]);
    await screen.findByText("Review before you sign");
    expect(
      screen.getByText(/Balance at the fresh read just now: 900,000 base units\./)
    ).toBeTruthy();
    expect(
      screen.getByText(
        /The balance changed between the scan and this read. SOL.REPAIR cannot tell what caused the change./
      )
    ).toBeTruthy();
    expectNoBannedPhrases();
  });

  it("renders the preview from the same builder the hook signs (§10.4.3)", async () => {
    await openReviewCard();
    fireEvent.click(screen.getByText("Inspect exactly what you’ll sign"));
    const pre = screen
      .getAllByText("Inspect exactly what you’ll sign")
      .map((el) => el.closest("details")?.querySelector("pre")?.textContent)
      .find(Boolean) as string;
    const parsed = JSON.parse(pre);
    const expected = buildRevokeInstruction(
      {
        pubkey: eligibleEntry.pubkey,
        mint: eligibleEntry.mint,
        balanceAtScan: eligibleEntry.balance ?? "0",
        decimals: eligibleEntry.decimals ?? 0,
        lamports: eligibleEntry.lamports ?? 0,
        program: eligibleEntry.program,
        delegate: DELEGATE,
      },
      OWNER.publicKey
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].instruction).toBe("revoke");
    expect(parsed[0].account).toBe(eligibleEntry.pubkey);
    expect(parsed[0].delegateAuthority).toBe(OWNER.publicKey.toBase58());
    expect(parsed[0].note).toBe("removes the delegate; balance untouched");
    expect(
      expected.keys.map((k) => k.pubkey.toBase58())
    ).toContain(eligibleEntry.pubkey);
  });

  it("shows gate aborts instead of an approval button", async () => {
    mocks.conn.getParsedAccountInfo.mockResolvedValue(
      parsedRead({ state: "frozen" })
    );
    render(
      <DelegationSection
        scan={scanWith([eligibleEntry])}
        rescan={() => {}}
        repairInFlight={false}
      />
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke delegate" })[0]);
    await screen.findByText(/now frozen/);
    // The row button remains, but the card offers no approval button.
    expect(
      screen.getAllByRole("button", { name: "Revoke delegate" })
    ).toHaveLength(1);
  });
});

describe("balance-observation copy (§8.2, §10.4.6)", () => {
  it("renders Case A wording for three matching reads", () => {
    expect(
      balanceObservationCopy("1000000", "1000000", "1000000")
    ).toContain("The recorded reads matched");
    expect(
      balanceObservationCopy("1000000", "1000000", "1000000")
    ).toContain("does not monitor the account between reads");
  });

  it("renders Case B wording for a pre-transaction change", () => {
    const text = balanceObservationCopy("1000000", "900000", "900000");
    expect(text).toContain("The change happened before the transaction");
    expect(text).toContain("cannot tell what caused it");
  });

  it("renders Case C wording with explicit non-attribution", () => {
    const text = balanceObservationCopy("1000000", "1000000", "700000");
    expect(text).toContain("cannot attribute the change");
    expect(text).toContain("does not claim the transaction caused it");
  });

  it("renders Case D wording when the after-read is unavailable", () => {
    const text = balanceObservationCopy("1000000", "1000000", null);
    expect(text).toContain("the balance result is unknown");
    expect(text).toContain("The revocation itself is verified; the balance is not.");
  });

  it("renders both transitions without attribution when both changed", () => {
    const text = balanceObservationCopy("1000000", "900000", "700000");
    expect(text).toContain("cannot attribute either change");
  });

  it("shows the matching-reads block on the success card (Case A)", () => {
    setHook({
      status: "done",
      outcome: "revoked-verified",
      accountPubkey: eligibleEntry.pubkey,
      balanceAtScan: "1000000",
      balanceBeforeAction: "1000000",
      balanceAfterAction: "1000000",
      delegatePresentAtLastRead: false,
      signatures: ["SIG1"],
    });
    render(
      <DelegationSection
        scan={scanWith([eligibleEntry])}
        rescan={() => {}}
        repairInFlight={false}
      />
    );
    expect(screen.getByText("Delegate revoked")).toBeTruthy();
    expect(
      screen.getByText(/confirmed by a fresh read after the transaction/)
    ).toBeTruthy();
    expect(screen.getByText(/The recorded reads matched/)).toBeTruthy();
    expectNoBannedPhrases();
  });
});

describe("terminal outcome cards (§8.9, §10.4.7-8)", () => {
  it("renders the causation-uncertain outcome without success wording (row 7)", () => {
    setHook({
      status: "done",
      outcome: "delegate-absent-unattributed",
      accountPubkey: eligibleEntry.pubkey,
      signatures: ["SIG9"],
      error:
        "The delegate is no longer on this account. Whether this app's transaction caused that could not be established.",
    });
    render(
      <DelegationSection
        scan={scanWith([eligibleEntry])}
        rescan={() => {}}
        repairInFlight={false}
      />
    );
    expect(
      screen.getByText(/Whether this app's transaction caused that could not be established/)
    ).toBeTruthy();
    expect(screen.queryByText("Delegate revoked")).toBeNull();
    // The receipt is rendered as an explorer link carrying the signature.
    expect(
      document.querySelector('a[href*="SIG9"]')
    ).toBeTruthy();
    expectNoBannedPhrases();
  });

  it("renders the uncertain card with the receipt and both permitted actions", () => {
    setHook({
      status: "unverified",
      outcome: "unresolved-outcome",
      signatures: ["SIG7"],
      error:
        "We could not verify whether the revoke landed. The transaction's outcome could not be established — it may still land. Nothing more will be sent automatically.",
    });
    render(
      <DelegationSection
        scan={scanWith([eligibleEntry])}
        rescan={() => {}}
        repairInFlight={false}
      />
    );
    expect(screen.getByText(/may still land/)).toBeTruthy();
    expect(document.querySelector('a[href*="SIG7"]')).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Rescan to check the current state" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(screen.queryByText("Delegate revoked")).toBeNull();
    expectNoBannedPhrases();
  });

  it("keeps the on-chain-failure observation separate from the transaction result", () => {
    setHook({
      status: "error",
      outcome: "on-chain-failure",
      delegatePresentAtLastRead: true,
      error:
        "The transaction was confirmed on-chain but failed. It changed nothing.",
    });
    render(
      <DelegationSection
        scan={scanWith([eligibleEntry])}
        rescan={() => {}}
        repairInFlight={false}
      />
    );
    expect(screen.getByText(/changed nothing/)).toBeTruthy();
    expect(
      screen.getByText(/the delegate was still on the account/)
    ).toBeTruthy();
    expectNoBannedPhrases();
  });

  it("renders the reapproved terminal inside the forbidden-phrase sweep (§10.4.4)", () => {
    setHook({
      status: "error",
      outcome: "delegate-reapproved-after",
      delegatePresentAtLastRead: true,
      error:
        "The transaction was confirmed by the network, but a fresh read shows a delegate on this account. SOL.REPAIR cannot tell what set it. Nothing more will be sent automatically.",
    });
    render(
      <DelegationSection
        scan={scanWith([eligibleEntry])}
        rescan={() => {}}
        repairInFlight={false}
      />
    );
    expect(screen.getByText(/cannot tell what set it/)).toBeTruthy();
    expect(screen.getByText(/a fresh read shows a delegate/)).toBeTruthy();
    // The attribution-flavored wording is gone, and the sweep passes.
    expect(document.body.textContent).not.toMatch(/another authority/);
    expectNoBannedPhrases();
  });

  it("renders the account-gone terminal with its own honest sentence", () => {
    setHook({
      status: "error",
      outcome: "account-gone",
      error:
        "The transaction expired without landing, and the account could not be found when we checked, so the delegate state could not be read. Nothing more will be sent automatically.",
    });
    render(
      <DelegationSection
        scan={scanWith([eligibleEntry])}
        rescan={() => {}}
        repairInFlight={false}
      />
    );
    expect(
      screen.getByText(/The transaction expired without landing/)
    ).toBeTruthy();
    expect(screen.queryByText(/may still land/)).toBeNull();
    expectNoBannedPhrases();
  });
});

describe("affordances (§8.12, §10.4.9)", () => {
  it("disables the revoke buttons while a repair is in flight, with the note", () => {
    render(
      <DelegationSection
        scan={scanWith([eligibleEntry])}
        rescan={() => {}}
        repairInFlight={true}
      />
    );
    const button = screen.getByRole("button", {
      name: "Revoke delegate",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      screen.getByText("Another wallet action is underway. Wait for it to finish.")
    ).toBeTruthy();
  });

  it("reports the in-flight signal upward for the repair button", () => {
    const onActionInFlightChange = vi.fn();
    setHook({ status: "confirming" }, true);
    render(
      <DelegationSection
        scan={scanWith([eligibleEntry])}
        rescan={() => {}}
        repairInFlight={false}
        onActionInFlightChange={onActionInFlightChange}
      />
    );
    expect(onActionInFlightChange).toHaveBeenLastCalledWith(true);
  });

  it("shows attempt-stage notes during the in-flight card", () => {
    setHook(
      {
        status: "building",
        note:
          "The transaction expired before the network confirmed it. Nothing landed. Retrying once with a fresh transaction — your approval is required again.",
      },
      true
    );
    render(
      <DelegationSection
        scan={scanWith([eligibleEntry])}
        rescan={() => {}}
        repairInFlight={false}
      />
    );
    expect(screen.getByText(/Retrying once with a fresh transaction/)).toBeTruthy();
    expectNoBannedPhrases();
  });

  it("invokes revoke with the reviewed delegation on approval", async () => {
    await openReviewCard();
    // The card's approval button is the LAST "Revoke delegate" button
    // (the first is the row's entry button).
    const buttons = screen.getAllByRole("button", { name: "Revoke delegate" });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({ pubkey: eligibleEntry.pubkey })
    );
  });
});
