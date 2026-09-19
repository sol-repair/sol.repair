// @vitest-environment jsdom

/**
 * Render tests for the transaction explainer page (/understand, M2).
 *
 * The page is read-only forever: no wallet, no signing. These tests pin
 * that promise in the copy, the input validation, every honest outcome
 * state (found, not found, unreadable, network error), and the wiring
 * end to end: a real library-serialized repair transaction goes in and
 * the plain-language sentences come out, with the fetch layer mocked at
 * its boundary so the decoder and explainer run for real.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  AuthorityType,
  createApproveInstruction,
  createSetAuthorityInstruction,
} from "@solana/spl-token";

const mocks = vi.hoisted(() => ({
  wallet: {} as Record<string, unknown>,
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.wallet,
}));

vi.mock("@/lib/solana/feeLedger", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/solana/feeLedger")>();
  return {
    ...actual,
    fetchRawTransaction: vi.fn(),
    fetchFeeSignatures: vi.fn(),
  };
});

import { fetchRawTransaction, fetchFeeSignatures } from "@/lib/solana/feeLedger";
import UnderstandPage from "@/app/understand/page";
import {
  buildLegacyRaw,
  closeIx,
  FEE_WALLET,
  systemTransfer as systemTransferIx,
} from "./fixtures/rawTransactions";

const VALID_SIGNATURE =
  "2V4dcrHEApzHDS9PqxWo1KeeK8a3HvVLyPsxVfq3yEktjdqH8NX77nzGZVT4QXTaVy8sWvszA8xDx8N2UrYGfrcw";

const mockedFetch = vi.mocked(fetchRawTransaction);
const mockedSignatureList = vi.mocked(fetchFeeSignatures);

function disconnectedWallet(): Record<string, unknown> {
  return {
    wallet: null,
    wallets: [],
    connect: vi.fn(),
    connected: false,
    connecting: false,
    disconnect: vi.fn(),
    publicKey: null,
  };
}

beforeEach(() => {
  mocks.wallet = disconnectedWallet();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function submitSignature(signature: string) {
  fireEvent.change(screen.getByLabelText(/transaction signature/i), {
    target: { value: signature },
  });
  fireEvent.click(screen.getByRole("button", { name: /explain it/i }));
}

describe("understand page renders its read-only promise", () => {
  it("states the page never connects a wallet and never asks for a signature", () => {
    render(<UnderstandPage />);
    expect(screen.getByText(/never connects a wallet/i)).toBeTruthy();
    expect(screen.getByText(/never asks you to sign anything/i)).toBeTruthy();
  });

  it("keeps the owner's writing rules on the static copy", () => {
    const { container } = render(<UnderstandPage />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[\u2014\u2013]/);
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(text).not.toMatch(/!/);
  });

  it("explains how to read the page, including wallet-added instructions", () => {
    render(<UnderstandPage />);
    expect(screen.getByText(/how to read this/i)).toBeTruthy();
    expect(
      screen.getByText(/Nothing on this page can sign anything\./i)
    ).toBeTruthy();
    expect(
      screen.getByText(/Wallets add their own instructions when they sign/i)
    ).toBeTruthy();
    expect(
      screen.getByText(
        /hands ownership of a token account to a different address/i
      )
    ).toBeTruthy();
    expect(
      screen.getByText(/failed on chain is reported as changed nothing/i)
    ).toBeTruthy();
  });
});

describe("understand page input validation", () => {
  it("rejects input that is not a signature shape without fetching", async () => {
    render(<UnderstandPage />);
    submitSignature("not-a-signature");
    expect(
      await screen.findByText(/does not look like a transaction signature/i)
    ).toBeTruthy();
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe("understand page outcomes", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it("explains a repair transaction end to end with real decode and explain", async () => {
    const { raw } = buildLegacyRaw([
      closeIx(),
      closeIx("token-2022"),
      systemTransferIx(new PublicKey(FEE_WALLET), 20_392),
    ]);
    mockedFetch.mockResolvedValue(raw);
    render(<UnderstandPage />);
    submitSignature(VALID_SIGNATURE);
    expect(
      await screen.findByText(/This transaction contains 3 instructions/i)
    ).toBeTruthy();
    const closeLines = await screen.findAllByText(
      /Close the token account/i
    );
    expect(closeLines).toHaveLength(2);
    expect(await screen.findByText(/0\.000020392 SOL/)).toBeTruthy();
    expect(await screen.findByText(new RegExp(FEE_WALLET))).toBeTruthy();
  });

  it("shows the left-behind verdict panel above the instructions", async () => {
    const { raw } = buildLegacyRaw([
      closeIx(),
      closeIx("token-2022"),
      systemTransferIx(new PublicKey(FEE_WALLET), 20_392),
    ]);
    mockedFetch.mockResolvedValue(raw);
    render(<UnderstandPage />);
    submitSignature(VALID_SIGNATURE);
    expect(
      await screen.findByText(/granted no new permissions/i)
    ).toBeTruthy();
    expect(
      await screen.findAllByText(/was closed\. Any permissions on it ended/i)
    ).toHaveLength(2);
  });

  it("reports a failed transaction as having changed nothing", async () => {
    const { raw } = buildLegacyRaw([closeIx()], {
      err: { InstructionError: [0, { Custom: 1 }] },
    });
    mockedFetch.mockResolvedValue(raw);
    render(<UnderstandPage />);
    submitSignature(VALID_SIGNATURE);
    expect(
      await screen.findByText(/This transaction failed on chain/i)
    ).toBeTruthy();
    expect(screen.queryByText(/was closed/i)).toBeNull();
  });

  it("warns through the panel when an approve granted a spending permission", async () => {
    const { raw } = buildLegacyRaw([
      createApproveInstruction(
        Keypair.generate().publicKey,
        Keypair.generate().publicKey,
        Keypair.generate().publicKey,
        500n
      ),
    ]);
    mockedFetch.mockResolvedValue(raw);
    render(<UnderstandPage />);
    submitSignature(VALID_SIGNATURE);
    expect(
      await screen.findByText(/left 1 lasting change/i)
    ).toBeTruthy();
    expect(
      await screen.findByText(/can now spend up to 500 base units/i)
    ).toBeTruthy();
  });

  it("shows the danger headline when an owner authority was handed over", async () => {
    const { raw } = buildLegacyRaw([
      createSetAuthorityInstruction(
        Keypair.generate().publicKey,
        Keypair.generate().publicKey,
        AuthorityType.AccountOwner,
        Keypair.generate().publicKey,
        []
      ),
    ]);
    mockedFetch.mockResolvedValue(raw);
    render(<UnderstandPage />);
    submitSignature(VALID_SIGNATURE);
    expect(
      await screen.findByText(/hands control of a token account/i)
    ).toBeTruthy();
    expect(
      await screen.findByText(/The account owner of token account/i)
    ).toBeTruthy();
  });

  it("lists the connected wallet's recent transactions and explains a chosen one", async () => {
    mocks.wallet = {
      wallet: { adapter: { name: "Phantom" } },
      wallets: [],
      connect: vi.fn(),
      connected: true,
      connecting: false,
      disconnect: vi.fn(),
      publicKey: Keypair.generate().publicKey,
    };
    mockedSignatureList.mockResolvedValue([
      {
        signature: VALID_SIGNATURE,
        blockTime: 1789215763,
      },
    ]);
    const { raw } = buildLegacyRaw([
      closeIx(),
      systemTransferIx(new PublicKey(FEE_WALLET), 20_392),
    ]);
    mockedFetch.mockResolvedValue(raw);
    render(<UnderstandPage />);
    const row = await screen.findByRole("button", { name: /2V4dcrHE/ });
    fireEvent.click(row);
    expect(
      await screen.findByText(/This transaction contains 2 instructions/i)
    ).toBeTruthy();
    expect(await screen.findByText(/0\.000020392 SOL/)).toBeTruthy();
  });

  it("says honestly when no transaction was found on this network", async () => {
    mockedFetch.mockResolvedValue(null);
    render(<UnderstandPage />);
    submitSignature(VALID_SIGNATURE);
    expect(
      await screen.findByText(/No transaction with that signature was found/i)
    ).toBeTruthy();
  });

  it("says honestly when the transaction data cannot be read", async () => {
    mockedFetch.mockResolvedValue({ blockTime: null, transaction: null });
    render(<UnderstandPage />);
    submitSignature(VALID_SIGNATURE);
    expect(
      await screen.findByText(/could not be read/i)
    ).toBeTruthy();
  });

  it("shows a friendly network error with the raw detail in small print", async () => {
    mockedFetch.mockRejectedValue(new Error("429 Connection rate limits exceeded"));
    render(<UnderstandPage />);
    submitSignature(VALID_SIGNATURE);
    expect(await screen.findByText(/Could not reach the RPC/i)).toBeTruthy();
    expect(await screen.findByText(/429 Connection rate limits exceeded/i)).toBeTruthy();
  });

  it("fetches from the endpoint matching the site's own cluster", async () => {
    mockedFetch.mockResolvedValue(null);
    render(<UnderstandPage />);
    submitSignature(VALID_SIGNATURE);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
    const endpoint = mockedFetch.mock.calls[0][0];
    expect(typeof endpoint === "string" && endpoint.startsWith("https://")).toBe(true);
  });
});
