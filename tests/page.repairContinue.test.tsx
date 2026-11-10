// @vitest-environment jsdom

/**
 * Post-run continue affordance tests (page.tsx).
 *
 * The pinned invariant (the acceptance condition this feature rides
 * on): for wallets whose fresh scan lists at or under
 * MAX_ACCOUNTS_PER_RUN eligible accounts, the rendered flow is
 * byte-identical to the pre-feature flow and the continue affordance
 * NEVER renders. The affordance exists only when a completed repair
 * run is followed by the standard post-run re-scan that still finds
 * MORE than one full run's worth of closable accounts, and the count
 * it states is that fresh scan's own eligible count. No new RPC call
 * pattern anywhere: the count comes from the scan the page already
 * holds, and the click path is the same repair() the main button
 * calls, through the same fresh fee-existence read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  Keypair,
  PublicKey,
  type Connection,
  type Transaction,
} from "@solana/web3.js";

import Home from "../src/app/page";
import { MAX_ACCOUNTS_PER_RUN } from "../src/hooks/useRepairWallet";
import {
  TOKEN_PROGRAM_ID,
  lamportsToSol,
  type ClosableAccount,
  type ScanResult,
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
  // The homepage mounts its Solana provider behind the lazy connect
  // boundary (and /report, /understand at their roots); these
  // passthroughs let the real provider component render with the
  // mocked wallet context underneath.
  ConnectionProvider: ({ children }: { children?: ReactNode }) =>
    children as ReactNode,
  WalletProvider: ({ children }: { children?: ReactNode }) =>
    children as ReactNode,
}));

vi.mock("@/hooks/useWalletScan", () => ({
  useWalletScan: () => mocks.scan,
}));

// The REAL repair hook runs here (no mock): the continue click must be
// proven to drive the same repair() path the main button drives, cap
// slice, fee re-check, and done-card bookkeeping included.
vi.mock("next/link", () => ({
  default: (props: { children?: unknown }) => props.children,
}));

const WALLET_KEYPAIR = Keypair.generate();

const RENT = 2039280;

function accountsOf(n: number): ClosableAccount[] {
  return Array.from({ length: n }, () => ({
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    lamports: RENT,
    program: "spl",
  }));
}

function scanOf(accounts: ClosableAccount[]): ScanResult {
  return {
    totalAccounts: accounts.length,
    eligibleAccounts: accounts,
    recoverableLamports: accounts.reduce(
      (sum, a) => sum + BigInt(a.lamports),
      0n
    ),
    skippedAccounts: [],
  };
}

// Shared data objects so the byte-identity pin can render the exact
// same wallet twice and compare DOM strings.
const ACCOUNTS_250 = accountsOf(250);
const ACCOUNTS_101 = accountsOf(101);
const ACCOUNTS_185 = accountsOf(185);
const ACCOUNTS_100 = accountsOf(MAX_ACCOUNTS_PER_RUN);
const ACCOUNTS_99 = accountsOf(99);
const ACCOUNTS_1 = accountsOf(1);
const SCAN_250 = scanOf(ACCOUNTS_250);
const SCAN_101 = scanOf(ACCOUNTS_101);
const SCAN_185 = scanOf(ACCOUNTS_185);
const SCAN_100 = scanOf(ACCOUNTS_100);
const SCAN_99 = scanOf(ACCOUNTS_99);
const SCAN_1 = scanOf(ACCOUNTS_1);
const SCAN_0: ScanResult = {
  totalAccounts: 0,
  eligibleAccounts: [],
  recoverableLamports: 0n,
  skippedAccounts: [],
};

/** Wire mocks for a full repair run: fee wallet present, blockhash
 *  fresh, every send confirmed, signer approves. */
function wireHappyPath() {
  mocks.conn.getAccountInfo.mockResolvedValue({
    lamports: 1,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    data: Buffer.alloc(0),
    rentEpoch: 0,
  });
  mocks.conn.getLatestBlockhash.mockResolvedValue({
    blockhash: PublicKey.default.toBase58(),
    lastValidBlockHeight: 1000,
  });
  mocks.conn.sendRawTransaction.mockResolvedValue("signed-tx-id");
  mocks.conn.getSignatureStatuses.mockResolvedValue({
    value: [{ err: null, confirmationStatus: "confirmed" }],
  });
  mocks.conn.getBlockHeight.mockResolvedValue(990);
  mocks.wallet.signTransaction = vi.fn(async (tx: Transaction) => {
    tx.sign(WALLET_KEYPAIR);
    return tx;
  });
}

/** Land the first scan the way the real page sees it: mount, then the
 *  result arrives on a later render. */
async function landInitialScan(scan: ScanResult) {
  const utils = await renderHome();
  await act(async () => {
    mocks.scan.result = scan;
    utils.rerender(<Home />);
  });
  return utils;
}

/** Drive one full repair to the done card (real hook, mocked chain). */
async function runRepairToDone() {
  fireEvent.click(screen.getByRole("button", { name: "Repair Wallet" }));
  await screen.findByText(/Inspect exactly what you/);
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Approve & Repair" })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.getByText(/Wallet repaired/)).toBeTruthy();
}

/** The post-run re-scan lands (the Done click's rescan, fresh result). */
async function landFreshScan(
  utils: ReturnType<typeof render>,
  scan: ScanResult
) {
  await act(async () => {
    mocks.scan.result = scan;
    utils.rerender(<Home />);
  });
}

/** The armed sequence: a capped 250-account run completes, Done is
 *  clicked (arming + the standard post-run re-scan), and a fresh scan
 *  of `fresh` accounts lands. */
async function armedWithFreshScan(
  fresh: ScanResult,
  initial: ScanResult = SCAN_250
) {
  wireHappyPath();
  const utils = await landInitialScan(initial);
  await runRepairToDone();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await landFreshScan(utils, fresh);
  return utils;
}

function continueButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: /Continue repair/ });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.conn.getAccountInfo.mockResolvedValue(null);
  mocks.wallet.publicKey = WALLET_KEYPAIR.publicKey;
  mocks.wallet.connected = true;
  mocks.wallet.signTransaction = null;
  mocks.scan.loading = false;
  mocks.scan.result = null;
  mocks.scan.error = null;
});

afterEach(() => {
  cleanup();
});

describe("post-run continue affordance", () => {
  it("arms only after a completed run, counts the fresh scan, and keeps the writing rules", async () => {
    await armedWithFreshScan(SCAN_185);

    const button = screen.getByRole("button", {
      name: "Continue repair (185 more found)",
    });
    expect(button).toBeTruthy();
    // The count is the fresh scan's own eligible count.
    expect(button.textContent).toContain("185");
    // The honest caption sits beside it, in the same block.
    expect(screen.getByText(/still lists 185 closable accounts/)).toBeTruthy();

    const block = button.closest("div")?.parentElement?.textContent ?? "";
    expect(block.includes("\u2014") || block.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(block)).toBe(false);
    expect(block.includes("!")).toBe(false);
    expect(block.toLowerCase().includes("the owner")).toBe(false);
  });

  it("never renders without a completed run, even well over the cap", async () => {
    const utils = await landInitialScan(SCAN_250);

    expect(continueButton()).toBeNull();
    // The normal flow is exactly today's: the main button, untouched.
    expect(
      screen.getByRole("button", { name: "Repair Wallet" })
    ).toBeTruthy();
    void utils;
  });

  it.each([
    [0, SCAN_0],
    [1, SCAN_1],
    [99, SCAN_99],
    [100, SCAN_100],
  ])(
    "never renders on a fresh scan of %i eligible accounts after a completed run",
    async (_count, fresh) => {
      await armedWithFreshScan(fresh);
      expect(continueButton()).toBeNull();
      expect(screen.queryByText(/more found/)).toBeNull();
    }
  );

  it("keeps the at-cap flow byte-identical: armed at 100 equals never armed at 100", async () => {
    // Baseline: the same 100-account wallet, no run ever completed.
    const base = await landInitialScan(SCAN_100);
    const baselineHtml = base.container.innerHTML;
    cleanup();

    // Armed: 250 run to done, Done clicked, the SAME 100-account scan
    // lands as the post-run re-scan. The affordance must add nothing:
    // every byte of the page matches the never-armed render.
    const armed = await armedWithFreshScan(SCAN_100);
    expect(armed.container.innerHTML).toBe(baselineHtml);
  });

  it(
    "starts the next normal run in place: same repair(), fresh fee re-check, no review detour",
    { timeout: 15000 },
    async () => {
      // Timeout widened for the same reason as its siblings below.
      await armedWithFreshScan(SCAN_101);

    const feeReadsBefore =
      mocks.conn.getAccountInfo.mock.calls.length;
    const sendsBefore = mocks.conn.sendRawTransaction.mock.calls.length;
    fireEvent.click(continueButton()!);

    // The fee re-check runs again at click time (the repair-time
    // re-check), before anything is signed.
    expect(
      mocks.conn.getAccountInfo.mock.calls.length
    ).toBeGreaterThan(feeReadsBefore);

    // 101 eligible: the repair hook slices to the 100 cap, five
    // transactions, and the review screen was never part of this path.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText(/Review before you sign/)).toBeNull();
    expect(screen.getByText(/Wallet repaired/)).toBeTruthy();
    expect(
      screen.getByText(
        `100 accounts closed. Recovered ${lamportsToSol(
          BigInt(MAX_ACCOUNTS_PER_RUN) * BigInt(RENT)
        )} SOL.`
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Run the repair again to close the remaining 1 account."
      )
    ).toBeTruthy();
    // Five sends from THIS run, on top of the arming run's five.
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(
      sendsBefore + 5
    );
    }
  );

  it(
    "clears once the continued run's fresh scan finds at or under the cap",
    { timeout: 15000 },
    async () => {
      // Timeout widened, not the assertion: under full-suite worker
      // contention these render-heavy drive tests run 3.5 to 5.6s
      // against an 800ms isolation baseline (the load-artifact class
      // the 2026-11-03 react-bump investigation recorded), and the
      // "repair everything found" suite adds one more file to the
      // same scheduling waves. 5s stopped being honest headroom.
      const utils = await armedWithFreshScan(SCAN_101);
      fireEvent.click(continueButton()!);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(screen.getByText(/Wallet repaired/)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await landFreshScan(utils, SCAN_1);

      expect(continueButton()).toBeNull();
      expect(screen.queryByText(/more found/)).toBeNull();
      // The one remaining account is handled by today's normal flow.
      expect(
        screen.getByRole("button", { name: "Repair Wallet" })
      ).toBeTruthy();
    }
  );

  it(
    "is disabled while the fee re-check is in flight",
    { timeout: 15000 },
    async () => {
      // Timeout widened for the same reason as its sibling above.
      await armedWithFreshScan(SCAN_185);

    let releaseFeeRead: ((value: null) => void) | null = null;
    mocks.conn.getAccountInfo.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          releaseFeeRead = resolve;
        })
    );

    // Open the main review path: its fresh fee read hangs, so the page
    // sits in the checkingFee window.
    fireEvent.click(screen.getByRole("button", { name: "Repair Wallet" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const button = continueButton();
    expect(button).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Repair Wallet" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);

    await act(async () => {
      releaseFeeRead?.(null);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The fee read resolved, the review opened, the affordance stands
    // down while the review is up.
    expect(screen.getByText(/Review before you sign/)).toBeTruthy();
    expect(continueButton()).toBeNull();
    }
  );
});
