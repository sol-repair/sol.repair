// @vitest-environment jsdom

/**
 * Component tests for NativeAccountsSection (spec §10.4): the finding
 * rows, the per-item consent card, the raw preview, the forbidden
 * phrasings (§6.3), the terminal-outcome cards (§8.9), and the
 * three-direction in-flight affordance (§8.11).
 *
 * The hook is mocked: its behavior is pinned exhaustively in
 * tests/useUnwrapNative.test.tsx. Here the hook's STATES are the
 * inputs and the rendered copy is what must be honest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";

import { NativeAccountsSection } from "../src/components/NativeAccountsSection";
import type { UnwrapState } from "../src/hooks/useUnwrapNative";
import {
  ALREADY_CLOSED_COPY,
  NATIVE_GATE_ABORT_COPY,
} from "../src/lib/solana/unwrapNative";
import type {
  ScanResult,
  SkippedAccount,
} from "../src/lib/solana/tokenAccounts";

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

vi.mock("@/hooks/useUnwrapNative", () => ({
  useUnwrapNative: vi.fn(),
}));

import { useUnwrapNative } from "@/hooks/useUnwrapNative";

const hookMock = vi.mocked(useUnwrapNative);

const OWNER = Keypair.generate();
const TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const NATIVE_MINT_STR = NATIVE_MINT.toBase58();
const T22_NATIVE_MINT_STR = "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP";

const idleState = (): UnwrapState => ({
  status: "idle",
  outcome: null,
  signatures: [],
  accountPubkey: null,
  amountAtScan: null,
  lamportsAtScan: null,
  amountBeforeAction: null,
  lamportsBeforeAction: null,
  accountPresentAfterAction: null,
  delegatePresent: null,
  note: null,
  error: null,
  errorDetail: null,
});

const unwrap = vi.fn();
const reset = vi.fn();

function setHook(over: Partial<UnwrapState>, actionInFlight = false) {
  hookMock.mockReturnValue({
    ...idleState(),
    ...over,
    actionInFlight,
    unwrap,
    reset,
  });
}

/** An EMPTY wrapped-sol skip: cause wrapped-sol, confirmed native. */
const emptyEntry: SkippedAccount = {
  pubkey: Keypair.generate().publicKey.toBase58(),
  mint: NATIVE_MINT_STR,
  reason: "is a wrapped-SOL account",
  program: "spl",
  cause: "wrapped-sol",
  lamports: 1488440,
  nativeStatus: "native",
};

/** A FUNDED wrapped-sol skip: cause funded, confirmed native. */
const fundedEntry: SkippedAccount = {
  pubkey: Keypair.generate().publicKey.toBase58(),
  mint: T22_NATIVE_MINT_STR,
  reason: "holds a token balance",
  program: "token-2022",
  cause: "funded",
  balance: "250000000",
  decimals: 9,
  lamports: 2488440,
  nativeStatus: "native",
};

/** The omitted-isNative skip: recorded, never offered. */
const unknownEntry: SkippedAccount = {
  pubkey: Keypair.generate().publicKey.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  reason: "is a wrapped-SOL account",
  program: "spl",
  cause: "wrapped-sol",
  lamports: 1488440,
  nativeStatus: "unknown",
};

const scanWith = (skipped: SkippedAccount[]): ScanResult => ({
  totalAccounts: skipped.length,
  eligibleAccounts: [],
  recoverableLamports: 0n,
  skippedAccounts: skipped,
});

/** A parsed-RPC single-account read of a native account (gate pass).
 *  The mint must match the reviewed candidate's native mint. */
const parsedRead = (over: {
  amount?: string;
  lamports?: number;
  delegate?: string;
  mint?: string;
} = {}) => ({
  value: {
    lamports: over.lamports ?? 2488440,
    owner: TOKEN_PROGRAM,
    data: {
      parsed: {
        info: {
          mint: over.mint ?? NATIVE_MINT_STR,
          owner: OWNER.publicKey.toBase58(),
          tokenAmount: {
            amount: over.amount ?? "250000000",
            decimals: 9,
            uiAmount: null,
            uiAmountString: "0",
          },
          ...(over.delegate === undefined ? {} : { delegate: over.delegate }),
          state: "initialized",
          isNative: true,
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
  /orphaned/i,
  /abandoned/i,
  /dust cleanup/i,
  // Unlabeled rent claims and rent/balance splits (§6.3): the recovery
  // figure is the account's total lamports, never presented as rent.
  /rent portion/i,
  /balance portion/i,
  /split into rent/i,
  /rent and .* balance are recover/i,
  // Unconditional movement claims (§6.3).
  /balance increased by/i,
  /balance rose by/i,
  /balance went up by/i,
  // Causal attribution (§6.3).
  /the delegate (changed|acted|moved) (it|the)/i,
  /someone (changed|drained|closed)/i,
  // Promise of undo (§6.3).
  /undo the close/i,
  /restore the account/i,
];

function expectNoBannedPhrases() {
  const text = document.body.textContent ?? "";
  for (const banned of BANNED) {
    expect(text).not.toMatch(banned);
  }
}

async function openReviewCard(entry: SkippedAccount = emptyEntry) {
  mocks.conn.getParsedAccountInfo.mockResolvedValue(parsedRead());
  render(
    <NativeAccountsSection
      scan={scanWith([entry])}
      rescan={() => {}}
      repairInFlight={false}
      revokeInFlight={false}
    />
  );
  fireEvent.click(
    screen.getAllByRole("button", { name: "Unwrap and close" })[0]
  );
  await screen.findByText("Review before you sign");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.holder.publicKey = OWNER.publicKey;
  setHook({});
});

afterEach(cleanup);

describe("finding rows (§6.2 block 1, §10.4.1)", () => {
  it("renders eligible rows with account, native mint, program, wrapped balance, and the lamports figure", () => {
    render(
      <NativeAccountsSection
        scan={scanWith([fundedEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    expect(screen.getByText(/Wrapped SOL/)).toBeTruthy();
    expect(
      screen.getByText(/1 account holds wrapped SOL \(a token-program representation of SOL\)/)
    ).toBeTruthy();
    expect(
      screen.getByText(/SOL\.REPAIR cannot tell why this account exists or whether anything still expects it\./)
    ).toBeTruthy();
    // The native mint travels on the row (full address in the tooltip).
    expect(screen.getByTitle(T22_NATIVE_MINT_STR)).toBeTruthy();
    expect(
      screen.getByText(/wrapped balance 250,000,000 base units \(9 decimals, at scan time\)/)
    ).toBeTruthy();
    expect(
      screen.getByText(/account holds 2,488,440 lamports total/)
    ).toBeTruthy();
    expect(screen.getByText(/Token-2022/)).toBeTruthy();
    expect(
      screen.getByText(
        /Only accounts the scan could confirm as wrapped-SOL are offered here/
      )
    ).toBeTruthy();
    expectNoBannedPhrases();
  });

  it("states the empty case's zero as the scan-check derivation, never a balance field", () => {
    render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    expect(
      screen.getByText(/wrapped balance 0 \(the scan's zero-balance check\)/)
    ).toBeTruthy();
    expect(
      screen.getByText(/account holds 1,488,440 lamports total/)
    ).toBeTruthy();
    expect(screen.getByText(/SPL Token Program/)).toBeTruthy();
    expectNoBannedPhrases();
  });

  it("carries the position-dependency sentence in the per-row explanation (§6.2 block 2, DoD 8)", () => {
    const { container } = render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    fireEvent.click(screen.getByText("What closing this account means"));
    const text = container.textContent ?? "";
    expect(text).toContain(
      "SOL.REPAIR cannot tell whether this account is a leftover or whether something still depends on it. That judgment is yours."
    );
    expect(text).toContain("Closing is not undoable by this tool");
    expect(text).toContain(
      "including any SOL that was sent to its address directly"
    );
    expect(text).toContain(
      "Swaps and other programs open one, use it, and often leave it behind."
    );
    expect(text).toContain(
      "SOL.REPAIR does not perform any transfer of its own."
    );
    expect(text).toContain(
      "If a program you use still expects this account to exist (some positions and orders are held in wrapped SOL), that program will see the account gone after the close."
    );
    expectNoBannedPhrases();
  });

  it("offers no row for an unknown-native skip (§10.4.1)", () => {
    render(
      <NativeAccountsSection
        scan={scanWith([unknownEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    expect(screen.queryByText("Wrapped SOL")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Unwrap and close" })
    ).toBeNull();
  });
});

describe("the confirmation card (§6.2 block 4, §10.4.2)", () => {
  it("pins the single-instruction claim, destination-is-your-wallet, and the fee lines", async () => {
    await openReviewCard();
    expect(
      screen.getByText(
        new RegExp(
          `You are about to approve 1 transaction that closes wrapped-SOL account .*\\. Every lamport it holds, 2,488,440 at the fresh read just now, goes to your wallet`
        )
      )
    ).toBeTruthy();
    expect(screen.getByText(/The account will no longer exist\./)).toBeTruthy();
    expect(
      screen.getByText(
        /Wrapped balance at scan: 0 base units\. At the fresh read just now: 250,000,000 base units\. Total lamports at scan: 1,488,440\. At the fresh read just now: 2,488,440\./
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        /This transaction contains exactly one instruction: closeAccount, from the SPL Token Program, with your wallet as both the destination and the authority\. It does not transfer tokens to any other address\./
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Network fee: ~0\.000005 SOL, paid from your wallet\. Your wallet may add its own priority fee\. No service fee: you are recovering your own SOL\./
      )
    ).toBeTruthy();
    // The empty candidate's scan figures (0 / 1,488,440) differ from the
    // fresh read: the drift line IS shown, attributed to nobody.
    expect(
      screen.getByText(
        "The account changed between the scan and this read. SOL.REPAIR cannot tell what caused the change."
      )
    ).toBeTruthy();
    expectNoBannedPhrases();
  });

  it("omits the drift line when the fresh read matches the scan figures", async () => {
    mocks.conn.getParsedAccountInfo.mockResolvedValue(
      parsedRead({ amount: "0", lamports: 1488440 })
    );
    render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Unwrap and close" })[0]
    );
    await screen.findByText("Review before you sign");
    expect(
      screen.queryByText(
        "The account changed between the scan and this read. SOL.REPAIR cannot tell what caused the change."
      )
    ).toBeNull();
  });

  it("shows the Case-B drift line, attributed to nobody, when the figures moved (§10.4.2)", async () => {
    mocks.conn.getParsedAccountInfo.mockResolvedValue(
      parsedRead({ amount: "240000000", lamports: 2591200 })
    );
    render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Unwrap and close" })[0]
    );
    await screen.findByText("Review before you sign");
    expect(
      screen.getByText(
        "The account changed between the scan and this read. SOL.REPAIR cannot tell what caused the change."
      )
    ).toBeTruthy();
    expectNoBannedPhrases();
  });

  it("adds the delegate sentence when the fresh read shows a delegate (§7.6)", async () => {
    mocks.conn.getParsedAccountInfo.mockResolvedValue(
      parsedRead({ mint: T22_NATIVE_MINT_STR, delegate: OWNER.publicKey.toBase58() })
    );
    render(
      <NativeAccountsSection
        scan={scanWith([fundedEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Unwrap and close" })[0]
    );
    await screen.findByText("Review before you sign");
    expect(
      screen.getByText(
        /It first revokes the delegate on this account, then closes it\./
      )
    ).toBeTruthy();
    expect(
      screen.getByText(/exactly two instructions: a revoke, then closeAccount/)
    ).toBeTruthy();
  });

  it("renders the raw preview from the instruction object the hook signs, with the pinned field names (§10.4.3)", async () => {
    await openReviewCard();
    fireEvent.click(
      screen.getByText(/Inspect exactly what you.ll sign/)
    );
    const pre = document.querySelector("pre");
    expect(pre).toBeTruthy();
    const entries = JSON.parse(pre!.textContent ?? "[]");
    expect(entries).toHaveLength(1);
    expect(entries[0].instruction).toBe("closeAccount");
    expect(entries[0].destination).toBe(OWNER.publicKey.toBase58());
    expect(entries[0].authority).toBe(OWNER.publicKey.toBase58());
    expect(entries[0].account).toBe(emptyEntry.pubkey);
    expect(entries[0].note).toBe(
      "every lamport in the account goes to the destination"
    );
  });

  it("renders the revoke pair first in the raw preview when a delegate is present", async () => {
    mocks.conn.getParsedAccountInfo.mockResolvedValue(
      parsedRead({ delegate: OWNER.publicKey.toBase58() })
    );
    render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Unwrap and close" })[0]
    );
    await screen.findByText("Review before you sign");
    fireEvent.click(screen.getByText(/Inspect exactly what you.ll sign/));
    const pre = document.querySelector("pre");
    const entries = JSON.parse(pre!.textContent ?? "[]");
    expect(entries).toHaveLength(2);
    expect(entries[0].instruction).toBe("revoke");
    expect(entries[1].instruction).toBe("closeAccount");
    expect(entries[1].destination).toBe(OWNER.publicKey.toBase58());
  });

  it("shows the gate copy instead of an approval button on a gate abort", async () => {
    mocks.conn.getParsedAccountInfo.mockResolvedValue({ value: null });
    render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Unwrap and close" })[0]
    );
    await screen.findByText("Review before you sign");
    expect(
      screen.getByText(
        "This account no longer exists. It may already have been closed. Nothing was signed."
      )
    ).toBeTruthy();
    expect(screen.queryByText("Run pre-sign simulation")).toBeNull();
    // No approval path in the card: the "about to approve" paragraph is
    // gone with it.
    expect(
      screen.queryByText(/You are about to approve 1 transaction/)
    ).toBeNull();
  });
});

describe("terminal-outcome cards (§6.2 blocks 5-7, §10.4.5)", () => {
  it("renders verified success with the scoped destination claim — never a balance-increase claim", () => {
    setHook({
      status: "done",
      outcome: "unwrap-verified",
      accountPubkey: emptyEntry.pubkey,
      lamportsBeforeAction: 2488440,
      signatures: ["sig555"],
    });
    const { container } = render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    expect(screen.getByText("Wrapped SOL returned.")).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text).toContain(
      "no longer exists, confirmed by a fresh read after the transaction."
    );
    expect(text).toMatch(
      /Its last recorded lamports \(2,488,440, read just before the close\) went to your wallet as the close.s destination\./
    );
    expect(screen.getByText("View on Solscan")).toBeTruthy();
    expectNoBannedPhrases();
  });

  it("renders close-unattributed with its own sentence, never worded as this app's success (row 7)", () => {
    setHook({
      status: "done",
      outcome: "close-unattributed",
      accountPubkey: emptyEntry.pubkey,
      error:
        "The account is gone. Whether this app's transaction closed it could not be established.",
    });
    render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    expect(screen.queryByText("Wrapped SOL returned.")).toBeNull();
    expect(
      screen.getByText(
        "The account is gone. Whether this app's transaction closed it could not be established."
      )
    ).toBeTruthy();
    expectNoBannedPhrases();
  });

  it("renders the failure card with the on-chain-failure observation", () => {
    setHook({
      status: "error",
      outcome: "on-chain-failure",
      error:
        "The transaction was confirmed on-chain but failed. It changed nothing.",
      accountPresentAfterAction: true,
    });
    render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    expect(screen.getByText("The unwrap did not go through")).toBeTruthy();
    expect(
      screen.getByText(
        "The transaction was confirmed on-chain but failed. It changed nothing."
      )
    ).toBeTruthy();
    expect(
      screen.getByText("When we checked, the account still existed.")
    ).toBeTruthy();
    expectNoBannedPhrases();
  });

  it("renders the uncertain card as distinct from success and failure", () => {
    setHook({
      status: "unverified",
      outcome: "unresolved-outcome",
      error:
        "We could not verify whether the close landed. The transaction's outcome could not be established. It may still land. Nothing more will be sent automatically.",
      signatures: ["sig777"],
    });
    render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    expect(
      screen.getByText("We could not verify whether the close landed")
    ).toBeTruthy();
    expect(screen.getByText("View on Solscan")).toBeTruthy();
    // No false success and no failure verdict.
    expect(screen.queryByText("Wrapped SOL returned.")).toBeNull();
    expect(screen.queryByText("The unwrap did not go through")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Rescan to check the current state" })
    ).toBeTruthy();
    expectNoBannedPhrases();
  });
});

describe("the three-direction in-flight affordance (§8.11, §10.4.6)", () => {
  it.each([
    ["repair", true, false],
    ["revoke", false, true],
  ])("disables its buttons while the %s action is in flight, with the note", (_label, repair, revoke) => {
    render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={repair}
        revokeInFlight={revoke}
      />
    );
    const button = screen.getByRole("button", {
      name: "Unwrap and close",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      screen.getByText("Another wallet action is underway. Wait for it to finish.")
    ).toBeTruthy();
  });

  it("disables its buttons while its own action is in flight", () => {
    setHook({ status: "confirming" }, true);
    render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    const button = screen.getByRole("button", {
      name: "Unwrap and close",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("keeps the elapsed counter out of the live region", () => {
    setHook({ status: "confirming" }, true);
    render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    expect(screen.getByRole("status")).toBeTruthy();
    // The per-second counter is visual only: inside the live region it
    // would re-announce the whole card every tick (audit F5).
    expect(screen.getByText("0s").getAttribute("aria-hidden")).toBe("true");
  });

  it("leaves the buttons enabled when no action is in flight", () => {
    render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    const button = screen.getByRole("button", {
      name: "Unwrap and close",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(
      screen.queryByText("Another wallet action is underway. Wait for it to finish.")
    ).toBeNull();
  });
});

/* The §10.4.4 sweep extended (owner review of the G.3 (f) ruling):
   every hook state the earlier blocks did not render is now inside the
   forbidden-phrase sweep, additive-only. */
const RECREATED_COPY =
  "The transaction was confirmed by the network, but a fresh read shows an account at this address again. SOL.REPAIR cannot tell what created it. Nothing more will be sent automatically.";

describe("the forbidden-phrase sweep across the remaining states (§10.4.4, additive)", () => {
  it.each([
    [
      "awaiting-signature",
      { status: "awaiting-signature" } as Partial<UnwrapState>,
    ],
    [
      "done / already-closed",
      {
        status: "done",
        outcome: "already-closed",
        error: ALREADY_CLOSED_COPY,
        accountPresentAfterAction: false,
      } as Partial<UnwrapState>,
    ],
    [
      "error / gate-state-changed",
      {
        status: "error",
        outcome: "gate-state-changed",
        error: NATIVE_GATE_ABORT_COPY["foreign-close-authority"],
      } as Partial<UnwrapState>,
    ],
    [
      "error / cancelled",
      {
        status: "error",
        outcome: "cancelled",
        error: "Transaction cancelled. Nothing was sent.",
      } as Partial<UnwrapState>,
    ],
    [
      "error / recreated-after-close",
      {
        status: "error",
        outcome: "recreated-after-close",
        error: RECREATED_COPY,
        accountPresentAfterAction: true,
      } as Partial<UnwrapState>,
    ],
    [
      "unverified / confirmed-verification-unavailable",
      {
        status: "unverified",
        outcome: "confirmed-verification-unavailable",
        error:
          "The transaction was confirmed by the network, but the follow-up read failed, so the account's closure is unverified.",
      } as Partial<UnwrapState>,
    ],
  ])("sweeps banned phrases in %s", (_label, over) => {
    setHook(over);
    render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    expectNoBannedPhrases();
  });

  it("observes the recreation edge without attributing it (the (f) ruling)", () => {
    setHook({
      status: "error",
      outcome: "recreated-after-close",
      error: RECREATED_COPY,
      accountPresentAfterAction: true,
    });
    render(
      <NativeAccountsSection
        scan={scanWith([emptyEntry])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
      />
    );
    const text = document.body.textContent ?? "";
    // It is rendered, it observes, and it names no actor.
    expect(text).toContain("cannot tell what created it");
    expect(text).toContain("Nothing more will be sent automatically.");
    expect(text).not.toMatch(
      /we (re)?created|SOL\.REPAIR (re)?created|our transaction|this app (re)?created|someone (re)?created|a bot (re)?created/i
    );
    // Distinct from success and from the failure card's verdict.
    expect(screen.queryByText("Wrapped SOL returned.")).toBeNull();
    expectNoBannedPhrases();
  });
});
