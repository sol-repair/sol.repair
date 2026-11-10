// @vitest-environment jsdom

/**
 * "Repair everything found" pass tests (HomeApp).
 *
 * The pass bundles the two existing repair-side flows under ONE
 * page-level confirmation: stage 1 is the existing repair() run over
 * the scan's empty accounts (cap slice, batching, and reporting all
 * inside the untouched hook), stage 2 is the existing burn() action
 * once per dust candidate in scan order. Nothing here builds a
 * transaction of its own: the REAL repair and burn hooks run against a
 * mocked chain, so every signed transaction in these tests comes out of
 * the same builders the per-section flows use.
 *
 * Owner-confirmed semantics pinned here (rulings 2026-11-10):
 *   - the pass is offered for empty-only, dust-only, and combined scans;
 *   - one confirmation, then only wallet approvals until a stop;
 *   - a rejection (or any non-skip failure) stops the WHOLE pass;
 *   - a per-account gate abort / already-empty / already-gone is an
 *     honest skip and the pass continues;
 *   - the cap stays 100 inside the pass and the shipped one-click
 *     continue composes with it (armed by the pass's own finish).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
} from "@solana/web3.js";

import Home from "../src/app/page";
import { MAX_ACCOUNTS_PER_RUN } from "../src/hooks/useRepairWallet";
import { BURN_GATE_ABORT_COPY } from "../src/lib/solana/burnDust";
import {
  TOKEN_PROGRAM_ID,
  lamportsToSol,
  type ClosableAccount,
  type ScanResult,
  type SkippedAccount,
} from "../src/lib/solana/tokenAccounts";
import type { ReactNode } from "react";
import { renderHome } from "./renderHome";

const mocks = vi.hoisted(() => ({
  wallet: {
    publicKey: null as PublicKey | null,
    signTransaction: null as
      | null
      | ((tx: Transaction) => Promise<Transaction>),
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
  conn: {
    getAccountInfo: vi.fn(),
    getParsedAccountInfo: vi.fn(),
    getMultipleAccountsInfo: vi.fn(),
    getLatestBlockhash: vi.fn(),
    sendRawTransaction: vi.fn(),
    getSignatureStatuses: vi.fn(),
    getBlockHeight: vi.fn(),
    simulateTransaction: vi.fn(),
  },
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.wallet,
  useConnection: () => ({ connection: mocks.conn as unknown as Connection }),
  ConnectionProvider: ({ children }: { children?: ReactNode }) =>
    children as ReactNode,
  WalletProvider: ({ children }: { children?: ReactNode }) =>
    children as ReactNode,
}));

vi.mock("@/hooks/useWalletScan", () => ({
  useWalletScan: () => mocks.scan,
}));

// The REAL repair and burn hooks run here (no mocks): the pass must be
// proven to drive the same repair() and burn() the per-section flows
// drive. The lifecycle's polling rhythm is the one compression: the
// recorded pacing constant is mocked down so the full-suite worker
// contention these long real-time sleeps caused (the heavy repair-drive
// tests' 5s defaults) does not reprice everyone else's timeouts. The
// mocked chain answers on the first poll regardless, so no assertion
// depends on the pacing.
vi.mock("@/lib/solana/actionLifecycle", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/solana/actionLifecycle")>();
  return { ...actual, RESOLVE_POLL_INTERVAL_MS: 1 };
});

vi.mock("next/link", () => ({
  default: (props: { children?: unknown }) => props.children,
}));

const WALLET_KEYPAIR = Keypair.generate();
const RENT = 2039280;
const DUST_BALANCE = "1234567";

function emptiesOf(n: number): ClosableAccount[] {
  return Array.from({ length: n }, () => ({
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    lamports: RENT,
    program: "spl",
  }));
}

function dustOf(n: number): SkippedAccount[] {
  return Array.from({ length: n }, () => ({
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    reason: "holds tokens",
    program: "spl",
    cause: "funded",
    balance: DUST_BALANCE,
    decimals: 6,
    lamports: RENT,
    frozen: false,
    nativeStatus: "non-native",
  }));
}

function scanOf(
  empties: ClosableAccount[],
  skipped: SkippedAccount[] = []
): ScanResult {
  return {
    totalAccounts: empties.length + skipped.length,
    eligibleAccounts: empties,
    recoverableLamports: empties.reduce(
      (sum, a) => sum + BigInt(a.lamports),
      0n
    ),
    skippedAccounts: skipped,
  };
}

/** The mocked chain's view of each dust account: a parsed token account
 *  until a burn transaction lands for it, then gone. `sticky` accounts
 *  stay readable after their burn lands (the recreated case); `frozen`
 *  accounts read back frozen at the gate. */
const chain = {
  open: new Map<string, { mint: string; frozen: boolean }>(),
  sticky: new Set<string>(),
};

function seedChain(
  dust: SkippedAccount[],
  options: { frozen?: string[]; sticky?: string[] } = {}
) {
  chain.open.clear();
  chain.sticky.clear();
  for (const d of dust) {
    chain.open.set(d.pubkey, {
      mint: d.mint,
      frozen: options.frozen?.includes(d.pubkey) ?? false,
    });
  }
  for (const s of options.sticky ?? []) chain.sticky.add(s);
}

/** Wire mocks for full runs: fee wallet present, blockhash fresh, every
 *  send confirmed, signer approves. A landed burn transaction closes its
 *  account on the mocked chain (the first key of a Burn instruction). */
function wireHappyPath() {
  mocks.conn.getAccountInfo.mockResolvedValue({
    lamports: 1,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    data: Buffer.alloc(0),
    rentEpoch: 0,
  });
  mocks.conn.getParsedAccountInfo.mockImplementation(
    async (pubkey: PublicKey) => {
      const entry = chain.open.get(pubkey.toBase58());
      if (!entry) return { value: null };
      return {
        value: {
          lamports: RENT,
          owner: TOKEN_PROGRAM_ID,
          executable: false,
          rentEpoch: 0,
          data: {
            program: "spl-token",
            parsed: {
              type: "account",
              info: {
                owner: WALLET_KEYPAIR.publicKey.toBase58(),
                mint: entry.mint,
                state: entry.frozen ? "frozen" : "initialized",
                isNative: false,
                tokenAmount: { amount: DUST_BALANCE, decimals: 6 },
              },
            },
          },
        },
      };
    }
  );
  mocks.conn.getLatestBlockhash.mockResolvedValue({
    blockhash: PublicKey.default.toBase58(),
    lastValidBlockHeight: 1000,
  });
  // The repair hook's own chain re-read after a refused or failed
  // attempt: every empty account it asks about is still open (still
  // owned by the token program), exactly what the chain reports when a
  // rejected approval sent nothing.
  mocks.conn.getMultipleAccountsInfo.mockImplementation(
    async (pubkeys: PublicKey[]) =>
      pubkeys.map(() => ({
        lamports: RENT,
        owner: TOKEN_PROGRAM_ID,
        executable: false,
        rentEpoch: 0,
        data: Buffer.alloc(0),
      }))
  );
  mocks.conn.sendRawTransaction.mockImplementation(async (raw: Buffer) => {
    const tx = Transaction.from(raw);
    for (const ix of tx.instructions) {
      // Token program Burn = instruction tag 8; its first key is the
      // token account being burned from.
      if (ix.data[0] === 8) {
        const account = ix.keys[0].pubkey.toBase58();
        if (!chain.sticky.has(account)) chain.open.delete(account);
      }
    }
    return "signed-tx-id";
  });
  mocks.conn.getSignatureStatuses.mockResolvedValue({
    value: [{ err: null, confirmationStatus: "confirmed" }],
  });
  mocks.conn.getBlockHeight.mockResolvedValue(990);
  mocks.wallet.signTransaction = vi.fn(async (tx: Transaction) => {
    tx.sign(WALLET_KEYPAIR);
    return tx;
  });
}

async function landInitialScan(scan: ScanResult) {
  const utils = await renderHome();
  await act(async () => {
    mocks.scan.result = scan;
    utils.rerender(<Home />);
  });
  return utils;
}

async function landFreshScan(
  utils: ReturnType<typeof render>,
  scan: ScanResult
) {
  await act(async () => {
    mocks.scan.result = scan;
    utils.rerender(<Home />);
  });
}

function passButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: /Repair everything found \(/ });
}

/** Click the pass button and wait for its one confirmation card. */
async function openPassConfirmation() {
  fireEvent.click(passButton()!);
  await screen.findByRole("button", { name: "Approve & start" });
}

async function startPass() {
  await openPassConfirmation();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Approve & start" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const LONG = { timeout: 15000 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.conn.getAccountInfo.mockResolvedValue(null);
  mocks.wallet.publicKey = WALLET_KEYPAIR.publicKey;
  mocks.wallet.connected = true;
  mocks.wallet.signTransaction = null;
  mocks.scan.loading = false;
  mocks.scan.result = null;
  mocks.scan.error = null;
  chain.open.clear();
  chain.sticky.clear();
});

afterEach(() => {
  cleanup();
});

describe("repair everything found: the offer and the one confirmation", () => {
  it("offers the pass with the scan's own counts and opens one confirmation enumerating both stages", async () => {
    wireHappyPath();
    const dust = dustOf(2);
    seedChain(dust);
    await landInitialScan(scanOf(emptiesOf(3), dust));

    expect(
      screen.getByRole("button", {
        name: "Repair everything found (3 empty, 2 dust)",
      })
    ).toBeTruthy();

    await openPassConfirmation();

    // Both stages, with counts and the approvals each one asks for.
    expect(
      screen.getByText(
        /Stage 1, close empty accounts: 3 accounts in 1 transaction, one wallet approval each\./
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Stage 2, burn and close dust: 2 accounts, one transaction and one wallet approval each\./
      )
    ).toBeTruthy();
    expect(screen.getByText(/Total approvals expected: 3\./)).toBeTruthy();

    // The permanence sentence at full strength, the dust section's own.
    expect(
      screen.getAllByText(
        /Burning a token destroys it permanently, and SOL\.REPAIR cannot judge what a token is worth or whether it is still wanted\. That judgment is yours\./
      ).length
    ).toBeGreaterThan(0);
    expect(
      screen.getByText(
        /Burning permanently destroys the token balance\. It is not undoable by this tool or any tool\./
      )
    ).toBeTruthy();

    // Every dust candidate enumerated with its scan balance.
    const card = screen
      .getByRole("button", { name: "Approve & start" })
      .closest("[data-testid='repair-everything-confirmation']");
    expect(card).toBeTruthy();
    const text = card!.textContent ?? "";
    for (const d of dust) {
      expect(text).toContain(d.pubkey.slice(0, 6));
    }
    expect(text.split("1,234,567 base units").length - 1).toBe(2);

    // The stop and skip rules are stated before anything starts.
    expect(
      screen.getByText(
        /If you reject an approval, the pass stops there, and everything already finished stays finished\./
      )
    ).toBeTruthy();

    // Writing rules on the whole confirmation.
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });

  it("is offered for an empty-only scan and for a dust-only scan, with honest labels", async () => {
    wireHappyPath();
    const utils = await landInitialScan(scanOf(emptiesOf(4)));
    expect(
      screen.getByRole("button", { name: "Repair everything found (4 empty)" })
    ).toBeTruthy();

    const dust = dustOf(1);
    seedChain(dust);
    await landFreshScan(utils, scanOf([], dust));
    expect(
      screen.getByRole("button", { name: "Repair everything found (1 dust)" })
    ).toBeTruthy();
    // Dust-only: the classic repair button has nothing to offer, the
    // per-card burn flow is still there.
    expect(screen.queryByRole("button", { name: "Repair Wallet" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Burn and close" })
    ).toBeTruthy();
  });

  it("is not offered when the scan found nothing this tool can close", async () => {
    wireHappyPath();
    const frozenFunded: SkippedAccount = {
      ...dustOf(1)[0],
      frozen: true,
    };
    await landInitialScan(scanOf([], [frozenFunded]));
    expect(passButton()).toBeNull();
  });

  it("leaves the classic flows in place beside the offer, and cancel closes the confirmation with nothing signed", async () => {
    wireHappyPath();
    const dust = dustOf(1);
    seedChain(dust);
    await landInitialScan(scanOf(emptiesOf(2), dust));

    expect(
      screen.getByRole("button", { name: "Repair Wallet" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Burn and close" })
    ).toBeTruthy();

    await openPassConfirmation();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByRole("button", { name: "Approve & start" })
    ).toBeNull();
    expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
    expect(mocks.conn.sendRawTransaction).not.toHaveBeenCalled();
    // Back to exactly the pre-click controls.
    expect(passButton()).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Repair Wallet" })
    ).toBeTruthy();
  });
});

describe("repair everything found: the stages", () => {
  it("empty-only: runs the same capped repair, then arms the shipped continue on finish", async () => {
    wireHappyPath();
    // 105, not a bigger crowd: the cap behavior (slice to 100, the rest
    // continue after) is identical and the DOM stays light enough not to
    // starve the heaviest tests' 5s defaults under full-suite load.
    const utils = await landInitialScan(scanOf(emptiesOf(105)));

    await openPassConfirmation();
    // The cap is stated: 100 per run, exactly as the classic review says.
    expect(
      screen.getByText(
        /This run covers the first 100 of the 105 found\./
      )
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Approve & start" })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(
      () =>
        expect(
          screen.getByText(/Everything this pass covered is finished\./)
        ).toBeTruthy(),
      LONG
    );
    // The cap slice: five transactions of 20, through repair().
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(5);
    expect(
      screen.getByText(
        `Closed 100 empty accounts, recovered ${lamportsToSol(
          BigInt(MAX_ACCOUNTS_PER_RUN) * BigInt(RENT)
        )} SOL.`
      )
    ).toBeTruthy();
    // One finish action, not two: the classic success card stands down.
    expect(screen.queryByText(/Wallet repaired/)).toBeNull();
    expect(screen.queryByText(/Review before you sign/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Finish and rescan" }));
    expect(mocks.scan.rescan).toHaveBeenCalledTimes(1);

    // The post-pass re-scan still lists more than one run's worth: the
    // shipped continue affordance renders, armed by the pass's finish.
    await landFreshScan(utils, scanOf(emptiesOf(101)));
    expect(
      screen.getByRole("button", { name: "Continue repair (101 more found)" })
    ).toBeTruthy();
  });

  it(
    "dust-only: burns each candidate through the burn hook, one approval each, and reports per account",
    async () => {
      wireHappyPath();
      const dust = dustOf(2);
      seedChain(dust);
      await landInitialScan(scanOf([], dust));

      await openPassConfirmation();
      expect(screen.queryByText(/Stage 1, close empty accounts/)).toBeNull();
      expect(screen.getByText(/Total approvals expected: 2\./)).toBeTruthy();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Approve & start" })
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await waitFor(
        () =>
          expect(
            screen.getByText(/Everything this pass covered is finished\./)
          ).toBeTruthy(),
        LONG
      );
      expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(2);
      expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(2);
      expect(
        screen.getAllByText(/burned and closed, verified on-chain\./).length
      ).toBe(2);
      // No stage 1 ran, so nothing is claimed for it.
      expect(screen.queryByText(/empty account/)).toBeNull();

      // Every signed transaction is the solo burn shape: burn, close,
      // then the fee transfer riding last. Nothing else.
      for (const call of mocks.conn.sendRawTransaction.mock.calls) {
        const tx = Transaction.from(call[0] as Buffer);
        expect(tx.instructions.length).toBe(3);
        expect(tx.instructions[0].data[0]).toBe(8);
        expect(tx.instructions[1].data[0]).toBe(9);
        expect(
          tx.instructions[2].programId.equals(
            new PublicKey("11111111111111111111111111111111")
          )
        ).toBe(true);
      }

      fireEvent.click(
        screen.getByRole("button", { name: "Finish and rescan" })
      );
      expect(mocks.scan.rescan).toHaveBeenCalledTimes(1);
    },
    30000
  );

  it(
    "combined: stage 1 then stage 2 with no second confirmation, classic sections stand down while it runs",
    async () => {
      wireHappyPath();
      const dust = dustOf(1);
      seedChain(dust);
      // Hold the burn's approval open so the mid-pass page can be
      // examined deterministically: approval one is the repair batch,
      // approval two is the burn.
      let releaseBurnApproval: (() => void) | null = null;
      let approvals = 0;
      mocks.wallet.signTransaction = vi.fn(async (tx: Transaction) => {
        approvals += 1;
        if (approvals === 2) {
          await new Promise<void>((resolve) => {
            releaseBurnApproval = resolve;
          });
        }
        tx.sign(WALLET_KEYPAIR);
        return tx;
      });
      await landInitialScan(scanOf(emptiesOf(3), dust));

      await startPass();

      // Stage 2 is waiting on the wallet, in the burn hook's own words.
      await waitFor(
        () =>
          expect(
            screen.getByText(/Check your wallet\. Approve to burn and close\./)
          ).toBeTruthy(),
        LONG
      );
      expect(
        screen.getByText(/stage 2, burn and close \(\s*1 of 1\)\./)
      ).toBeTruthy();

      // While the pass owns the wallet, the classic entry points are
      // not offered: no second way to start a conflicting action.
      expect(screen.queryByRole("button", { name: "Repair Wallet" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Burn and close" })
      ).toBeNull();
      expect(passButton()).toBeNull();

      await act(async () => {
        releaseBurnApproval?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await waitFor(
        () =>
          expect(
            screen.getByText(/Everything this pass covered is finished\./)
          ).toBeTruthy(),
        LONG
      );
      // One repair approval, one burn approval, nothing in between.
      expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(/Review before you sign/)).toBeNull();
      expect(
        screen.getByText(
          `Closed 3 empty accounts, recovered ${lamportsToSol(
            3n * BigInt(RENT)
          )} SOL.`
        )
      ).toBeTruthy();
      expect(
        screen.getAllByText(/burned and closed, verified on-chain\./).length
      ).toBe(1);

      // Stage 1's transaction is the classic repair shape: three closes
      // and the fee transfer riding last.
      const first = Transaction.from(
        mocks.conn.sendRawTransaction.mock.calls[0][0] as Buffer
      );
      expect(first.instructions.length).toBe(4);
      expect(first.instructions.slice(0, 3).every((ix) => ix.data[0] === 9)).toBe(
        true
      );
    },
    30000
  );
});

describe("repair everything found: stops and skips", () => {
  it(
    "a rejected approval stops the whole pass: nothing further is requested",
    async () => {
      wireHappyPath();
      const dust = dustOf(3);
      seedChain(dust);
      let signs = 0;
      mocks.wallet.signTransaction = vi.fn(async (tx: Transaction) => {
        signs += 1;
        if (signs === 2) throw new Error("User rejected the request.");
        tx.sign(WALLET_KEYPAIR);
        return tx;
      });
      await landInitialScan(scanOf([], dust));

      await startPass();

      await waitFor(
        () => expect(screen.getByText(/The pass stopped\./)).toBeTruthy(),
        LONG
      );
      // The hook's own words, verbatim: once as the reason the pass
      // stopped, once on the account it stopped at.
      expect(
        screen.getAllByText(/Transaction cancelled\. Nothing was sent\./)
          .length
      ).toBe(2);
      // One burn landed before the refusal; the third was never asked for.
      expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(2);
      expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
      expect(
        screen.getAllByText(/burned and closed, verified on-chain\./).length
      ).toBe(1);
      expect(
        screen.queryByText(/Everything this pass covered is finished\./)
      ).toBeNull();
    },
    30000
  );

  it(
    "an account that changed is skipped with the gate's reason and the pass continues",
    async () => {
      wireHappyPath();
      const dust = dustOf(3);
      seedChain(dust, { frozen: [dust[1].pubkey] });
      await landInitialScan(scanOf([], dust));

      await startPass();

      await waitFor(
        () =>
          expect(
            screen.getByText(/Everything this pass covered is finished\./)
          ).toBeTruthy(),
        LONG
      );
      // The frozen one was never signed for; the other two burned.
      expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(2);
      expect(
        screen.getAllByText(/burned and closed, verified on-chain\./).length
      ).toBe(2);
      expect(
        screen.getByText(new RegExp(BURN_GATE_ABORT_COPY.frozen.replace(/\./g, "\\.")))
      ).toBeTruthy();
      // Exactly one account carries the skip marker in the pass log.
      expect(screen.getAllByText(/: skipped\. /).length).toBe(1);
    },
    30000
  );

  it(
    "an account still present after a confirmed burn stops the pass: nothing more is sent automatically",
    async () => {
      wireHappyPath();
      const dust = dustOf(2);
      seedChain(dust, { sticky: [dust[0].pubkey] });
      await landInitialScan(scanOf([], dust));

      await startPass();

      await waitFor(
        () => expect(screen.getByText(/The pass stopped\./)).toBeTruthy(),
        LONG
      );
      // The hook's promise, verbatim: as the stop reason and on the
      // account it stopped at.
      expect(
        screen.getAllByText(/Nothing more will be sent automatically\./)
          .length
      ).toBe(2);
      // The second candidate was never signed for.
      expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
    },
    30000
  );

  it("a stage 1 failure stops before any burn is attempted, with the repair's own report", async () => {
    wireHappyPath();
    const dust = dustOf(2);
    seedChain(dust);
    mocks.wallet.signTransaction = vi.fn(async () => {
      throw new Error("User rejected the request.");
    });
    await landInitialScan(scanOf(emptiesOf(3), dust));

    await startPass();

    await waitFor(
      () => expect(screen.getByText(/The pass stopped\./)).toBeTruthy(),
      LONG
    );
    // The classic repair error card carries the honest report.
    expect(screen.getByText("Repair failed")).toBeTruthy();
    expect(
      screen.getAllByText(/Transaction cancelled\. Nothing was sent\./).length
    ).toBeGreaterThan(0);
    // Stage 2 never began: no burn gate read, no burn approval.
    expect(mocks.conn.getParsedAccountInfo).not.toHaveBeenCalled();
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).not.toHaveBeenCalled();
  });
});
