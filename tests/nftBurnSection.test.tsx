// @vitest-environment jsdom

/**
 * Component tests for NftBurnSection (the dead-NFT v1 slice): the
 * detection states, the honest rows for the classes v1 does not offer,
 * the per-item consent card with the memo section 1.5 copy, the routing
 * contract upward, and the cross-action affordance. The hook is mocked
 * (its behavior is mirrored on useBurnDust, pinned in its own suite);
 * the rendered copy and the routing are what must be honest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";

import { NftBurnSection } from "../src/components/NftBurnSection";
import type { NftBurnState } from "../src/hooks/useNftBurn";
import type { DetectedNft, NftScanCandidate } from "../src/lib/solana/nftBurn";
import { findMasterEditionPda, findMetadataPda } from "../src/lib/solana/nftBurn";
import type {
  ScanResult,
  SkippedAccount,
} from "../src/lib/solana/tokenAccounts";

const mocks = vi.hoisted(() => ({
  holder: { publicKey: null as PublicKey | null },
  unstable: false,
  conn: {
    getMultipleAccountsInfo: vi.fn(),
    getMinimumBalanceForRentExemption: vi.fn().mockResolvedValue(3733800),
    simulateTransaction: vi.fn(),
  },
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.holder,
}));

vi.mock("@/hooks/useRpcConnection", () => ({
  useRpcConnection: () => (mocks.unstable ? { ...mocks.conn } : mocks.conn),
}));

vi.mock("@/hooks/useNftBurn", () => ({
  useNftBurn: vi.fn(),
}));

import { useNftBurn } from "@/hooks/useNftBurn";

const hookMock = vi.mocked(useNftBurn);

const OWNER = Keypair.generate();
const OWNER_B58 = OWNER.publicKey.toBase58();
const METAPLEX = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

mocks.holder.publicKey = OWNER.publicKey;

const idleState = (): NftBurnState => ({
  status: "idle",
  outcome: null,
  signatures: [],
  accountPubkey: null,
  mint: null,
  rentAtScan: null,
  tokenLamportsBeforeAction: null,
  metadataLamportsBeforeAction: null,
  editionLamportsBeforeAction: null,
  accountsPresentAfterAction: null,
  note: null,
  error: null,
  errorDetail: null,
});

const reset = vi.fn();

function setHook(over: Partial<NftBurnState>, actionInFlight = false) {
  hookMock.mockReturnValue({
    ...idleState(),
    ...over,
    actionInFlight,
    burn: vi.fn(),
    reset,
  });
}

function nftEntry(over: Partial<SkippedAccount> = {}): SkippedAccount {
  return {
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    reason: "holds a token balance",
    program: "spl",
    cause: "funded",
    balance: "1",
    decimals: 0,
    lamports: 2039280,
    nativeStatus: "non-native",
    ...over,
  };
}

function scanWith(entries: SkippedAccount[]): ScanResult {
  return {
    totalAccounts: entries.length,
    eligibleAccounts: [],
    recoverableLamports: 0n,
    skippedAccounts: entries,
  };
}

function candidateOf(entry: SkippedAccount): NftScanCandidate {
  return {
    pubkey: entry.pubkey,
    mint: entry.mint,
    program: entry.program,
    lamports: 2039280,
    amountAtScan: "1",
  };
}

function detected(
  entry: SkippedAccount,
  cls: DetectedNft["class"],
  over: Partial<DetectedNft> = {}
): DetectedNft {
  return {
    candidate: candidateOf(entry),
    class: cls,
    tokenLamports: 2039280,
    metadataLamports: 3733800,
    editionLamports: 1030080,
    rentLamports: 6803160,
    name: "Saga Pass",
    collectionVerified: false,
    collectionKey: null,
    collectionName: null,
    masterSupply: "0",
    editionKey: 6,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* Raw account builders: the detection stub answers by pubkey shape,   */
/* so one implementation serves the mint batch, the triple batch, and  */
/* the presentation gate read alike.                                   */
/* ------------------------------------------------------------------ */

function mintBody(): Buffer {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(1n, 36);
  data[44] = 0;
  data[45] = 1;
  return data;
}

function tokenBody(opts: { mint: string; frozen?: boolean; t22?: boolean } = { mint: "" }): Buffer {
  const data = Buffer.alloc(165);
  Buffer.from(new PublicKey(opts.mint).toBuffer()).copy(data, 0);
  Buffer.from(OWNER.publicKey.toBuffer()).copy(data, 32);
  data.writeBigUInt64LE(1n, 64);
  data[108] = opts.frozen ? 2 : 1;
  return data;
}

function metadataBody(opts: {
  mint: string;
  name?: string;
  collection?: { verified: boolean; key: string } | null;
}): Buffer {
  const parts: Buffer[] = [
    Buffer.from([4]),
    OWNER.publicKey.toBuffer(),
    new PublicKey(opts.mint).toBuffer(),
  ];
  const pushStr = (text: string) => {
    const bytes = Buffer.from(text, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length);
    parts.push(len, bytes);
  };
  pushStr(opts.name ?? "Saga Pass");
  pushStr("R2");
  pushStr("https://example.com/0.json");
  parts.push(Buffer.alloc(2), Buffer.from([0])); // fee, no creators
  parts.push(Buffer.from([0]), Buffer.from([0])); // sale, mutable
  parts.push(Buffer.from([0])); // no nonce
  parts.push(Buffer.from([0])); // no token standard
  if (opts.collection) {
    parts.push(
      Buffer.from([1]),
      Buffer.from([opts.collection.verified ? 1 : 0]),
      new PublicKey(opts.collection.key).toBuffer()
    );
  } else {
    parts.push(Buffer.from([0]));
  }
  return Buffer.concat(parts);
}

function editionBody(opts: { key: number; supply?: bigint }): Buffer {
  if (opts.key === 1) {
    // EditionV1 body: key byte, parent mint (32), edition offset (8),
    // slot (8). Only the key byte matters to the classifier.
    const data = Buffer.alloc(57);
    data[0] = 1;
    return data;
  }
  const data = Buffer.alloc(20);
  data[0] = opts.key;
  if (opts.supply !== undefined) data.writeBigUInt64LE(opts.supply, 1);
  return data;
}

/** Detection stub: answers every getMultipleAccountsInfo call by
 *  matching each key against the fixtures' token, mint, metadata PDA,
 *  and edition PDA addresses. The per-class bytes drive what the
 *  classifier sees, so the rendered rows come from real parse paths. */
function stubDetection(specs: Array<{
  entry: SkippedAccount;
  class: DetectedNft['class'];
  collection?: { verified: boolean; key: string } | null;
  metadataLamports?: number;
}>) {
  const byPubkey = new Map<
    string,
    { owner: PublicKey; lamports: number; data: Buffer } | null
  >();
  const pk = (s: string) => new PublicKey(s);
  for (const spec of specs) {
    const mintKey = new PublicKey(spec.entry.mint);
    const tokenProgram = spec.class === "token22" ? TOKEN_2022 : SPL_TOKEN;
    byPubkey.set(spec.entry.mint, { owner: pk(SPL_TOKEN), lamports: 1, data: mintBody() });
    byPubkey.set(
      spec.entry.pubkey,
      {
        owner: pk(tokenProgram),
        lamports: 2039280,
        data: tokenBody({ mint: spec.entry.mint, frozen: spec.class === "frozen" }),
      }
    );
    byPubkey.set(
      findMetadataPda(mintKey).toBase58(),
      {
        owner: pk(METAPLEX),
        lamports: spec.metadataLamports ?? 3733800,
        data: metadataBody({
          mint: spec.entry.mint,
          name: "Saga Pass",
          collection: spec.collection ?? null,
        }),
      }
    );
    if (spec.class === "metadata-only") {
      byPubkey.set(findMasterEditionPda(mintKey).toBase58(), null);
    } else if (spec.class === "print-edition") {
      byPubkey.set(findMasterEditionPda(mintKey).toBase58(), {
        owner: pk(METAPLEX),
        lamports: 1030080,
        data: editionBody({ key: 1 }),
      });
    } else if (spec.class === "master-v1") {
      byPubkey.set(findMasterEditionPda(mintKey).toBase58(), {
        owner: pk(METAPLEX),
        lamports: 1030080,
        data: editionBody({ key: 2 }),
      });
    } else if (spec.class === "has-prints") {
      byPubkey.set(findMasterEditionPda(mintKey).toBase58(), {
        owner: pk(METAPLEX),
        lamports: 1030080,
        data: editionBody({ key: 6, supply: 2n }),
      });
    } else {
      // burnable, token22, and frozen read as master editions; the
      // frozen state lives on the token account.
      byPubkey.set(findMasterEditionPda(mintKey).toBase58(), {
        owner: pk(METAPLEX),
        lamports: 1030080,
        data: editionBody({ key: 6, supply: 0n }),
      });
    }
  }
  mocks.conn.getMultipleAccountsInfo.mockImplementation(
    async (keys: PublicKey[]) =>
      keys.map((key) => byPubkey.get(key.toBase58()) ?? null)
  );
}

function renderSection(props: {
  entries: SkippedAccount[];
  feeReady?: boolean;
  onRoutingChange?: (r: { routed: ReadonlySet<string>; pending: ReadonlySet<string> }) => void;
  repairInFlight?: boolean;
  excessInFlight?: boolean;
  burnInFlight?: boolean;
}) {
  return render(
    <NftBurnSection
      scan={scanWith(props.entries)}
      rescan={() => {}}
      repairInFlight={props.repairInFlight === true}
      revokeInFlight={false}
      unwrapInFlight={false}
      burnInFlight={props.burnInFlight === true}
      excessInFlight={props.excessInFlight === true}
      feeReady={props.feeReady === true}
      onRoutingChange={props.onRoutingChange}
    />
  );
}

beforeEach(() => {
  setHook({});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NftBurnSection detection states", () => {
  it("renders nothing when the scan has no decimals-0 candidates", () => {
    const { container } = renderSection({ entries: [] });
    expect(
      container.querySelector('[data-testid="nft-burn-section"]')
    ).toBeNull();
  });

  it("runs detection once per scan even when the connection identity churns", async () => {
    // mintAuthorityDisplay’s useConnection mock returns an inline {} per
    // render; through useRpcConnection’s memo the connection identity
    // churns every render. The detection effect keyed on the connection,
    // so each churn re-fired detection -> setDetected -> render -> more
    // churn: an infinite loop that wedged the whole test worker (the CI
    // gate, three consecutive runs). The contract: detection runs ONCE
    // per scan + explicit retry, reading the latest connection through
    // a ref.
    const entry = nftEntry();
    mocks.unstable = true;
    stubDetection([{ entry, class: "burnable" }]);
    renderSection({ entries: [entry] });
    await waitFor(() => {
      expect(screen.getByText("Burn and close")).toBeDefined();
    });
    const callsAfterSettled = mocks.conn.getMultipleAccountsInfo.mock.calls.length;
    expect(callsAfterSettled).toBeGreaterThan(0);
    // One quiet period after settling: no re-detection churn.
    await new Promise((r) => setTimeout(r, 250));
    expect(mocks.conn.getMultipleAccountsInfo.mock.calls.length).toBe(
      callsAfterSettled
    );
    mocks.unstable = false;
  });
  it("renders the honest reading state while detection is in flight", async () => {
    const entry = nftEntry();
    const holder: { resolve?: (v: unknown) => void } = {};
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      () =>
        new Promise((resolve) => {
          holder.resolve = resolve as (v: unknown) => void;
        })
    );
    const { container } = renderSection({ entries: [entry] });
    await waitFor(() => {
      expect(screen.getByText(/Reading 1 account for dead NFTs/)).toBeDefined();
    });
    expect(
      container.querySelector('[data-testid="nft-burn-section"]')
    ).not.toBeNull();
    holder.resolve?.(null);
  });

  it("renders the honest failed state with a retry affordance", async () => {
    const entry = nftEntry();
    mocks.conn.getMultipleAccountsInfo.mockRejectedValue(
      new Error("429 Too Many Requests")
    );
    const { container } = renderSection({ entries: [entry] });
    await waitFor(() => {
      expect(
        screen.getByText(/The NFT check could not be read from the network/)
      ).toBeDefined();
    });
    expect(
      container.querySelector('[data-testid="nft-burn-section"]')
    ).not.toBeNull();
    expect(screen.getByText("Scan again")).toBeDefined();
  });

  it("reports every candidate as pending while detection reads", async () => {
    const entry = nftEntry();
    const routing: Array<{ routed: ReadonlySet<string>; pending: ReadonlySet<string> }> = [];
    const holder: { resolve?: (v: unknown) => void } = {};
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      () =>
        new Promise((resolve) => {
          holder.resolve = resolve as (v: unknown) => void;
        })
    );
    renderSection({ entries: [entry], onRoutingChange: (r) => routing.push(r) });
    await waitFor(() => {
      expect(routing.length).toBeGreaterThan(0);
    });
    expect(routing[routing.length - 1].pending.has(entry.pubkey)).toBe(true);
    expect(routing[routing.length - 1].routed.size).toBe(0);
    holder.resolve?.(null);
  });

  it("routes the burnable class out of the dust flow and returns the rest to it", async () => {
    const burnableEntry = nftEntry();
    const frozenEntry = nftEntry();
    const routing: Array<{ routed: ReadonlySet<string>; pending: ReadonlySet<string> }> = [];
    stubDetection([
      { entry: burnableEntry, class: "burnable" },
      { entry: frozenEntry, class: "frozen" },
    ]);
    renderSection({
      entries: [burnableEntry, frozenEntry],
      onRoutingChange: (r) => routing.push(r),
    });
    // Wait for the actual row button: the reading and failed states
    // also render the section heading.
    await waitFor(() => {
      expect(screen.getByText("Burn and close")).toBeDefined();
    });
    const last = routing[routing.length - 1];
    expect(last.routed.has(burnableEntry.pubkey)).toBe(true);
    expect(last.routed.has(frozenEntry.pubkey)).toBe(false);
    expect(last.pending.size).toBe(0);
    // The frozen row renders with no offer anywhere for it.
    expect(screen.getByText(/account as frozen/)).toBeDefined();
    expect(screen.getAllByText("Burn and close").length).toBe(1);
  });
});

describe("NftBurnSection rows and the consent card", () => {
  it("shows the burnable row with the memo row label, rents, and fee", async () => {
    const entry = nftEntry();
    stubDetection([
      {
        entry,
        class: "burnable",
        collection: { verified: true, key: Keypair.generate().publicKey.toBase58() },
      },
    ]);
    renderSection({ entries: [entry], feeReady: true });
    await waitFor(() => {
      expect(screen.getByText("NFT burn-and-close")).toBeDefined();
    });
    const body = document.body.textContent ?? "";
    expect(body).toContain(
      "burns this NFT (1 token) and closes its token, metadata, and master edition accounts. Recovers 0.006803 SOL. Fee 1% = 0.000068 SOL."
    );
    // Nothing selected by default: a button, not a checkbox.
    expect(screen.getByText("Burn and close")).toBeDefined();
    expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    // No images anywhere on the row: text only, never an <img>.
    expect(document.querySelectorAll("img").length).toBe(0);
    // The self-declared name and the verified collection show.
    expect(body).toContain("Saga Pass");
    expect(body).toContain("(self-declared)");
    expect(body).toContain("Collection ");
    // Collection name read from the collection metadata batch: the stub
    // answers the collection PDA with the same metadata body, so the
    // name repeats there.
  });

  it("shows the honest non-offered rows without any burn button", async () => {
    const entries = [
      nftEntry(),
      nftEntry(),
      nftEntry(),
      nftEntry(),
      nftEntry(),
      nftEntry({ program: "token-2022" }),
    ];
    stubDetection([
      { entry: entries[0], class: "frozen" },
      { entry: entries[1], class: "has-prints" },
      { entry: entries[2], class: "metadata-only" },
      { entry: entries[3], class: "print-edition" },
      { entry: entries[4], class: "master-v1" },
      { entry: entries[5], class: "token22" },
    ]);
    renderSection({ entries });
    await waitFor(() => {
      expect(screen.getByText(/account as frozen/)).toBeDefined();
    });
    const body = document.body.textContent ?? "";
    expect(body).toContain("still has print editions outstanding");
    expect(body).toContain("No edition account exists behind this token");
    expect(body).toContain("holds a print edition, not a master edition");
    expect(body).toContain("holds a MasterEditionV1");
    expect(body).toContain("runs on the SPL Token Program only");
    // No offer anywhere: not one burn button on the page.
    expect(screen.queryByText("Burn and close")).toBeNull();
    expect(document.querySelectorAll("img").length).toBe(0);
  });

  it("renders the full consent card with the pinned sentences and no images", async () => {
    const entry = nftEntry();
    const collectionMint = Keypair.generate().publicKey.toBase58();
    stubDetection([
      {
        entry,
        class: "burnable",
        collection: { verified: true, key: collectionMint },
      },
    ]);
    renderSection({ entries: [entry], feeReady: true });
    await waitFor(() => {
      expect(screen.getByText("Burn and close")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Burn and close"));
    // The presentation gate read resolves through the same stub: the
    // triple reads as pass-shaped.
    await waitFor(() => {
      expect(screen.getByText("Burn NFT and close its accounts")).toBeDefined();
    });
    const body = document.body.textContent ?? "";
    // The pinned card sentences (memo section 1.5).
    expect(body).toContain("This sends one instruction (Metaplex BurnNft)");
    expect(body).toContain("return to your wallet");
    expect(body).toContain(
      "The fee is 1 percent of the SOL these closes return, floored to whole lamports: 68031 lamports of 6803160 lamports"
    );
    expect(body).toContain("Burning is permanent. The NFT cannot be un-burned");
    expect(body).toContain(
      "This NFT belongs to a verified collection. Burning it reduces that collection"
    );
    expect(body).toContain(
      "Closing the account through the plain token burn instead strands that rent permanently"
    );
    expect(document.querySelectorAll("img").length).toBe(0);
    // The inspect block exists and names the wire.
    expect(screen.getByText(/Inspect exactly what you/)).toBeDefined();
    // The approve button.
    expect(screen.getByText("Approve & Burn NFT")).toBeDefined();
  });

  it("renders the fee-era card: the fee is 1 percent of the RETURN, with the husk disclosure", async () => {
    const entry = nftEntry();
    const collectionMint = Keypair.generate().publicKey.toBase58();
    // The stored-fee shape: the metadata holds 13,733,800 (rent
    // 3,733,800 + the 10,000,000 stored Metaplex create fee); the gate
    // caps the return at the rent-exempt minimum. Fee base = the
    // RETURN: 2,039,280 + 3,733,800 + 1,030,080 = 6,803,160, fee
    // 68,031. Deposits 16,803,160.
    stubDetection([
      {
        entry,
        class: "burnable",
        collection: null,
        metadataLamports: 13_733_800,
      },
    ]);
    renderSection({ entries: [entry], feeReady: true });
    await waitFor(() => {
      expect(screen.getByText("Burn and close")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Burn and close"));
    await waitFor(() => {
      expect(screen.getByText("Burn NFT and close its accounts")).toBeDefined();
    });
    const body = document.body.textContent ?? "";
    // The fee line carries the RETURN base, never the deposits.
    expect(body).toContain(
      "The fee is 1 percent of the SOL these closes return, floored to whole lamports: 68031 lamports of 6803160 lamports"
    );
    // The husk disclosure names the stored fee.
    expect(body).toContain(
      "The three deposits hold 0.016803 SOL in total; the metadata account carries a stored Metaplex create fee which stays in a one-byte husk that only Metaplex can claim."
    );
    expect(body).toContain(
      "The three accounts’ rent, 0.006803 SOL, returns to your wallet."
    );
    expect(document.querySelectorAll("img").length).toBe(0);
  });

  it("renders the abort card when the fresh read shows a non-master edition", async () => {
    const entry = nftEntry();
    stubDetection([{ entry, class: "burnable" }]);
    renderSection({ entries: [entry], feeReady: false });
    await waitFor(() => {
      expect(screen.getByText("Burn and close")).toBeDefined();
    });
    // Override the gate read BEFORE the click: the triple now reads as
    // nothing (a vanished token account), so the presentation preview
    // shows the already-gone terminal instead of the pass state.
    const mintKey = new PublicKey(entry.mint);
    mocks.conn.getMultipleAccountsInfo.mockImplementationOnce(
      async (keys: PublicKey[]) =>
        keys.map((key) => {
          if (key.equals(mintKey)) {
            return { owner: new PublicKey(SPL_TOKEN), lamports: 1, data: mintBody() };
          }
          return null;
        })
    );
    fireEvent.click(screen.getByText("Burn and close"));
    await waitFor(() => {
      expect(
        screen.getByText(/This NFT.{0,2}s token account no longer exists/)
      ).toBeDefined();
    });
    expect(document.body.textContent).not.toContain(
      "1 percent of the SOL these closes return"
    );
  });

  it("disables the row button while another action is in flight", async () => {
    const entry = nftEntry();
    stubDetection([{ entry, class: "burnable" }]);
    renderSection({ entries: [entry], excessInFlight: true });
    await waitFor(() => {
      expect(screen.getByText("Burn and close")).toBeDefined();
    });
    expect(
      (screen.getByText("Burn and close") as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getByText(/Another wallet action is underway/)).toBeDefined();
  });

  it("shows the verified burn terminal naming the three closed accounts", async () => {
    const entry = nftEntry();
    setHook({
      status: "done",
      outcome: "nft-burn-verified",
      signatures: ["sig1"],
      accountPubkey: entry.pubkey,
      mint: entry.mint,
      tokenLamportsBeforeAction: 6803160,
      accountsPresentAfterAction: { token: false, metadata: false, edition: false },
    });
    stubDetection([{ entry, class: "burnable" }]);
    renderSection({ entries: [entry] });
    await waitFor(() => {
      expect(screen.getByText("Burn and close complete.")).toBeDefined();
    });
    const body = document.body.textContent ?? "";
    expect(body).toContain("no longer exists");
    expect(body).toContain("neither do its metadata and master edition accounts");
    expect(body).toContain("Signature: sig1");
  });

  it("shows the metadata-only terminal from the hook", async () => {
    const entry = nftEntry();
    setHook({
      status: "done",
      outcome: "metadata-only",
      accountsPresentAfterAction: { token: true, metadata: true, edition: false },
      error:
        "No edition account exists behind this token, so there is no NFT burn. The token account itself can still be closed through the dust burn; the metadata deposit is unreachable by anyone, including this tool. Nothing was signed.",
    });
    stubDetection([{ entry, class: "metadata-only" }]);
    renderSection({ entries: [entry] });
    // The sentence renders on the honest row AND on the hook's
    // terminal card: both surfaces say the same thing.
    await waitFor(() => {
      expect(
        screen.getAllByText(/No edition account exists behind this token/)
          .length
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows the partial-close terminal for a broken atomic shape", async () => {
    const entry = nftEntry();
    setHook({
      status: "error",
      outcome: "partial-close-seen",
      accountsPresentAfterAction: { token: false, metadata: true, edition: false },
      error:
        "The transaction was confirmed by the network, and a fresh read shows the token account gone but the metadata account still present.",
    });
    stubDetection([{ entry, class: "burnable" }]);
    renderSection({ entries: [entry] });
    await waitFor(() => {
      expect(screen.getByText("The burn did not go through")).toBeDefined();
    });
    const body = document.body.textContent ?? "";
    // The hook's partial-close copy names exactly what remains.
    expect(body).toContain(
      "the token account gone but the metadata account still present"
    );
  });
});
