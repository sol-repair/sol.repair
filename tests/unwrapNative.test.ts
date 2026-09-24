/**
 * G.3 pure-module tests (spec §10.1, §10.2): the unwrap selector's
 * eligibility contract, the builder's wire-level safety pins
 * (destination = owner as a fast-check property, tag 0x09 with three
 * keys, the revoke-before-close pair, no fee instruction ever), the
 * single-account read, the §8.3 gate evaluator, and the import
 * boundary.
 */

import { readFileSync, readdirSync } from "node:fs";

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { NATIVE_MINT, NATIVE_MINT_2022 } from "@solana/spl-token";

import {
  buildUnwrapInstruction,
  evaluateNativeGate,
  NATIVE_GATE_ABORT_COPY,
  readNativeAccountState,
  selectUnwrappableNativeAccounts,
  type NativeAccountRead,
  type UnwrappableNativeAccount,
} from "../src/lib/solana/unwrapNative";
import { selectRevocableDelegations } from "../src/lib/solana/revokeDelegation";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type ScanResult,
  type SkippedAccount,
} from "../src/lib/solana/tokenAccounts";

const OWNER = Keypair.generate().publicKey;
const SPL_NATIVE_MINT = NATIVE_MINT.toBase58();
const T22_NATIVE_MINT = NATIVE_MINT_2022.toBase58();
const ACCOUNT_PUBKEY = Keypair.generate().publicKey.toBase58();

const skipEntry = (over: Partial<SkippedAccount>): SkippedAccount => ({
  pubkey: Keypair.generate().publicKey.toBase58(),
  mint: SPL_NATIVE_MINT,
  reason: "is a wrapped-SOL account",
  program: "spl",
  cause: "wrapped-sol",
  nativeStatus: "native",
  lamports: 1488440,
  ...over,
});

const scanWith = (skipped: SkippedAccount[]): ScanResult => ({
  totalAccounts: skipped.length,
  eligibleAccounts: [],
  recoverableLamports: 0n,
  skippedAccounts: skipped,
});

const cleanCandidate = (): UnwrappableNativeAccount => ({
  pubkey: Keypair.generate().publicKey.toBase58(),
  mint: SPL_NATIVE_MINT,
  program: "spl",
  lamports: 1488440,
  amountAtScan: "0",
});

/* ------------------------------------------------------------------ */
/* §10.1 — the selector                                                */
/* ------------------------------------------------------------------ */

describe("selectUnwrappableNativeAccounts (§10.1)", () => {
  it("10.1.1 — selects an empty native account from the wrapped-sol feed", () => {
    const entry = skipEntry({
      cause: "wrapped-sol",
      nativeStatus: "native",
      lamports: 1488440,
    });
    const out = selectUnwrappableNativeAccounts(scanWith([entry]));
    expect(out).toHaveLength(1);
    expect(out[0].pubkey).toBe(entry.pubkey);
    expect(out[0].mint).toBe(SPL_NATIVE_MINT);
    expect(out[0].program).toBe("spl");
    expect(out[0].lamports).toBe(1488440);
    // The zero is a derivation from the scan's check order, recorded on
    // the candidate — never a scan balance field.
    expect(out[0].amountAtScan).toBe("0");
    expect(out[0].decimals).toBeUndefined();
  });

  it("10.1.2 — selects a funded native account with amountAtScan and decimals", () => {
    const entry = skipEntry({
      cause: "funded",
      reason: "holds a token balance",
      nativeStatus: "native",
      balance: "250000000",
      decimals: 9,
      lamports: 2488440,
    });
    const out = selectUnwrappableNativeAccounts(scanWith([entry]));
    expect(out).toHaveLength(1);
    expect(out[0].amountAtScan).toBe("250000000");
    expect(out[0].decimals).toBe(9);
    expect(out[0].lamports).toBe(2488440);
  });

  it("10.1.3 — refuses nativeStatus unknown (the omitted-isNative case the wrapped-sol site records)", () => {
    const out = selectUnwrappableNativeAccounts(
      scanWith([
        skipEntry({ cause: "wrapped-sol", nativeStatus: "unknown" }),
        skipEntry({
          cause: "funded",
          nativeStatus: "unknown",
          balance: "5",
          decimals: 9,
        }),
      ])
    );
    expect(out).toHaveLength(0);
  });

  it("10.1.4 — refuses confirmed non-native entries of any cause", () => {
    const out = selectUnwrappableNativeAccounts(
      scanWith([
        skipEntry({ cause: "wrapped-sol", nativeStatus: "non-native" }),
        skipEntry({
          cause: "funded",
          nativeStatus: "non-native",
          balance: "5",
          decimals: 9,
        }),
      ])
    );
    expect(out).toHaveLength(0);
  });

  it("10.1.5 — refuses a mint mismatch in either program (E4)", () => {
    const out = selectUnwrappableNativeAccounts(
      scanWith([
        skipEntry({
          cause: "wrapped-sol",
          nativeStatus: "native",
          mint: Keypair.generate().publicKey.toBase58(),
        }),
        skipEntry({
          cause: "funded",
          nativeStatus: "native",
          program: "token-2022",
          mint: SPL_NATIVE_MINT, // the SPL mint, on a T22 program account
          balance: "5",
          decimals: 9,
        }),
      ])
    );
    expect(out).toHaveLength(0);
  });

  it("10.1.6 — refuses missing or invalid lamports evidence, never defaulting it", () => {
    const out = selectUnwrappableNativeAccounts(
      scanWith([
        skipEntry({
          cause: "wrapped-sol",
          nativeStatus: "native",
          lamports: undefined,
        }),
        skipEntry({ cause: "wrapped-sol", nativeStatus: "native", lamports: 12.5 }),
        skipEntry({ cause: "wrapped-sol", nativeStatus: "native", lamports: -1 }),
        skipEntry({
          cause: "funded",
          nativeStatus: "native",
          balance: "5",
          decimals: 9,
          lamports: Number.NaN,
        }),
      ])
    );
    expect(out).toHaveLength(0);
  });

  it("10.1.7 — selects both programs and preserves the tag end-to-end into the programId", () => {
    const out = selectUnwrappableNativeAccounts(
      scanWith([
        skipEntry({ cause: "wrapped-sol", nativeStatus: "native" }),
        skipEntry({
          cause: "wrapped-sol",
          nativeStatus: "native",
          program: "token-2022",
          mint: T22_NATIVE_MINT,
        }),
      ])
    );
    expect(out.map((c) => c.program)).toEqual(["spl", "token-2022"]);
    for (const candidate of out) {
      const instructions = buildUnwrapInstruction(candidate, OWNER);
      expect(instructions).toHaveLength(1);
      expect(
        instructions[0].programId.equals(
          candidate.program === "token-2022"
            ? TOKEN_2022_PROGRAM_ID
            : TOKEN_PROGRAM_ID
        )
      ).toBe(true);
    }
  });

  it("10.1.8 — never reads the reason prose: a mutated reason changes nothing", () => {
    const pubkey = Keypair.generate().publicKey.toBase58();
    const base = skipEntry({
      cause: "wrapped-sol",
      nativeStatus: "native",
      pubkey,
    });
    const mutated = skipEntry({
      cause: "wrapped-sol",
      nativeStatus: "native",
      pubkey,
      reason: "totally different prose that no selector may ever match",
    });
    const a = selectUnwrappableNativeAccounts(scanWith([base]));
    const b = selectUnwrappableNativeAccounts(scanWith([mutated]));
    expect(b).toHaveLength(a.length);
    expect(b[0].pubkey).toBe(a[0].pubkey);
  });

  it("10.1.9 — classification invariance: the §5.2 fields change no cause, reason, or partition", () => {
    const entry = skipEntry({
      cause: "wrapped-sol",
      reason: "is a wrapped-SOL account",
      nativeStatus: "native",
      lamports: 1488440,
    });
    const out = selectUnwrappableNativeAccounts(scanWith([entry]));
    expect(out).toHaveLength(1);
    expect(entry.cause).toBe("wrapped-sol");
    expect(entry.reason).toBe("is a wrapped-SOL account");
  });

  it("10.1.10 — disjointness: no entry is ever eligible for BOTH G.3 and G.2's selector", () => {
    const entries: SkippedAccount[] = [
      skipEntry({ cause: "wrapped-sol", nativeStatus: "native", lamports: 1488440 }),
      skipEntry({ cause: "wrapped-sol", nativeStatus: "unknown", lamports: 1488440 }),
      skipEntry({ cause: "wrapped-sol", nativeStatus: "non-native", lamports: 1488440 }),
      skipEntry({
        cause: "funded",
        nativeStatus: "native",
        balance: "5",
        decimals: 9,
        delegated: true,
        delegate: Keypair.generate().publicKey.toBase58(),
      }),
      skipEntry({
        cause: "funded",
        nativeStatus: "non-native",
        balance: "5",
        decimals: 9,
        delegated: true,
        delegate: Keypair.generate().publicKey.toBase58(),
      }),
      skipEntry({
        cause: "funded",
        nativeStatus: "unknown",
        balance: "5",
        decimals: 9,
        delegated: true,
        delegate: Keypair.generate().publicKey.toBase58(),
      }),
    ];
    for (const entry of entries) {
      const scan = scanWith([entry]);
      const unwrap = selectUnwrappableNativeAccounts(scan);
      const revoke = selectRevocableDelegations(scan);
      // E2 ("native" only) and G.2's E5 ("non-native" only) are strict
      // complements: the two selectors can never claim the same entry.
      expect(unwrap.length > 0 && revoke.length > 0).toBe(false);
    }
  });

  it("carries scan delegate evidence on a funded delegated native (the pair builder's input)", () => {
    const delegate = Keypair.generate().publicKey.toBase58();
    const out = selectUnwrappableNativeAccounts(
      scanWith([
        skipEntry({
          cause: "funded",
          nativeStatus: "native",
          balance: "5",
          decimals: 9,
          delegated: true,
          delegate,
        }),
      ])
    );
    expect(out).toHaveLength(1);
    expect(out[0].delegate).toBe(delegate);
  });
});

/* ------------------------------------------------------------------ */
/* §10.2 — the builder's wire-level safety pins                        */
/* ------------------------------------------------------------------ */

describe("buildUnwrapInstruction (§10.2)", () => {
  it("10.2.1 — destination pin: keys are [account(w), destination=owner(w), authority=owner(s)]", () => {
    const instructions = buildUnwrapInstruction(cleanCandidate(), OWNER);
    expect(instructions).toHaveLength(1);
    const keys = instructions[0].keys;
    expect(keys).toHaveLength(3);
    expect(keys[0].isWritable).toBe(true);
    expect(keys[0].isSigner).toBe(false);
    expect(keys[1].pubkey.equals(OWNER)).toBe(true);
    expect(keys[1].isWritable).toBe(true);
    expect(keys[1].isSigner).toBe(false);
    expect(keys[2].pubkey.equals(OWNER)).toBe(true);
    expect(keys[2].isWritable).toBe(false);
    expect(keys[2].isSigner).toBe(true);
  });

  it("10.2.1 (property) — destination === owner for every generated owner and account", () => {
    // The builder takes no destination argument, so drift is
    // structurally excluded; this proves it on the wire over arbitrary
    // generated inputs.
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.constantFrom("spl" as const, "token-2022" as const),
        (ownerBytes, accountBytes, program) => {
          const owner = new PublicKey(ownerBytes);
          const candidate: UnwrappableNativeAccount = {
            pubkey: new PublicKey(accountBytes).toBase58(),
            mint: program === "token-2022" ? T22_NATIVE_MINT : SPL_NATIVE_MINT,
            program,
            lamports: 1488440,
            amountAtScan: "0",
          };
          const [close] = buildUnwrapInstruction(candidate, owner);
          return (
            close.keys[1].pubkey.equals(owner) &&
            close.keys[2].pubkey.equals(owner)
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it("10.2.2 — close data is exactly 1 byte 0x09; programId per program tag", () => {
    const spl = buildUnwrapInstruction(cleanCandidate(), OWNER);
    expect(spl[0].data).toHaveLength(1);
    expect(spl[0].data[0]).toBe(0x09);
    expect(spl[0].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);

    const t22 = buildUnwrapInstruction(
      { ...cleanCandidate(), program: "token-2022", mint: T22_NATIVE_MINT },
      OWNER
    );
    expect(t22[0].data).toHaveLength(1);
    expect(t22[0].data[0]).toBe(0x09);
    expect(t22[0].programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it("10.2.3 — a clean candidate builds exactly one instruction; no SystemProgram instruction ever", () => {
    const instructions = buildUnwrapInstruction(cleanCandidate(), OWNER);
    expect(instructions).toHaveLength(1);
    for (const ix of instructions) {
      expect(ix.programId.equals(SystemProgram.programId)).toBe(false);
    }
    // No transfer/approve/burn/sync-native tags: the only instruction's
    // tag is the close's 0x09.
    expect(instructions.every((ix) => ix.data[0] === 0x09)).toBe(true);
  });

  it("10.2.4 — a delegated candidate yields revoke (0x05) IMMEDIATELY before close (0x09); clean yields one", () => {
    const delegated: UnwrappableNativeAccount = {
      ...cleanCandidate(),
      delegate: Keypair.generate().publicKey.toBase58(),
    };
    const pair = buildUnwrapInstruction(delegated, OWNER);
    expect(pair).toHaveLength(2);
    expect(pair[0].data[0]).toBe(0x05);
    expect(pair[1].data[0]).toBe(0x09);
    // Same account, same owner-signer, same program on both.
    expect(pair[0].keys[0].pubkey.toBase58()).toBe(
      pair[1].keys[0].pubkey.toBase58()
    );
    expect(pair[0].keys).toHaveLength(2);
    expect(pair[0].keys[1].pubkey.equals(OWNER)).toBe(true);
    expect(pair[0].keys[1].isSigner).toBe(true);
    expect(pair[0].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);

    expect(buildUnwrapInstruction(cleanCandidate(), OWNER)).toHaveLength(1);
  });

  it("10.2.5 — no fee, ever: every built instruction belongs to a token program", () => {
    for (const candidate of [
      cleanCandidate(),
      {
        ...cleanCandidate(),
        delegate: Keypair.generate().publicKey.toBase58(),
      },
    ]) {
      const instructions = buildUnwrapInstruction(candidate, OWNER);
      expect(instructions.length).toBeGreaterThanOrEqual(1);
      for (const ix of instructions) {
        // A fee would be a SystemProgram transfer; nothing but the
        // owning token program's revoke/close ever leaves this builder.
        const isTokenProgram =
          ix.programId.equals(TOKEN_PROGRAM_ID) ||
          ix.programId.equals(TOKEN_2022_PROGRAM_ID);
        expect(isTokenProgram).toBe(true);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* §10.2 — the single-account read and the §8.3 gate evaluator         */
/* ------------------------------------------------------------------ */

const parsedNativeRead = (
  over: {
    lamports?: number;
    mint?: string;
    walletOwner?: string;
    amount?: string;
    decimals?: number;
    delegate?: string | null;
    closeAuthority?: string | null;
    state?: string;
    isNative?: boolean;
    programOwner?: PublicKey;
  } = {}
) => ({
  value: {
    lamports: over.lamports ?? 2488440,
    owner: over.programOwner ?? TOKEN_PROGRAM_ID,
    data: {
      parsed: {
        info: {
          mint: over.mint ?? SPL_NATIVE_MINT,
          owner: over.walletOwner ?? OWNER.toBase58(),
          tokenAmount: {
            amount: over.amount ?? "250000000",
            decimals: over.decimals ?? 9,
            uiAmount: null,
            uiAmountString: "0",
          },
          ...(over.delegate === undefined ? {} : { delegate: over.delegate }),
          ...(over.closeAuthority === undefined
            ? {}
            : { closeAuthority: over.closeAuthority }),
          state: over.state ?? "initialized",
          isNative: over.isNative ?? true,
        },
      },
    },
  },
});

const connectionReading = (response: unknown) =>
  ({
    getParsedAccountInfo: async () => response,
  }) as unknown as Connection;

describe("readNativeAccountState (§8.3 read half)", () => {
  it("maps a parsed native account onto the full read shape", async () => {
    const delegate = Keypair.generate().publicKey.toBase58();
    const read = await readNativeAccountState(
      connectionReading(
        parsedNativeRead({ delegate, closeAuthority: OWNER.toBase58() })
      ),
      cleanCandidate().pubkey
    );
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(read.program).toBe("spl");
    expect(read.walletOwner).toBe(OWNER.toBase58());
    expect(read.mint).toBe(SPL_NATIVE_MINT);
    expect(read.state).toBe("initialized");
    expect(read.nativeStatus).toBe("native");
    expect(read.amount).toBe("250000000");
    expect(read.decimals).toBe(9);
    expect(read.lamports).toBe(2488440);
    expect(read.closeAuthority).toBe(OWNER.toBase58());
    expect(read.delegate).toBe(delegate);
  });

  it("reports a missing account", async () => {
    const read = await readNativeAccountState(
      connectionReading({ value: null }),
      cleanCandidate().pubkey
    );
    expect(read).toEqual({ kind: "missing" });
  });

  it("reports unreadable for a non-token-program owner, a malformed envelope, or invalid numbers", async () => {
    const systemOwned = parsedNativeRead({
      programOwner: SystemProgram.programId,
    });
    expect(
      (await readNativeAccountState(connectionReading(systemOwned), ACCOUNT_PUBKEY)).kind
    ).toBe("unreadable");

    const noParsed = {
      value: { lamports: 1, owner: TOKEN_PROGRAM_ID, data: {} },
    };
    expect(
      (await readNativeAccountState(connectionReading(noParsed), ACCOUNT_PUBKEY)).kind
    ).toBe("unreadable");

    const badAmount = parsedNativeRead({ amount: "12.5" });
    expect(
      (await readNativeAccountState(connectionReading(badAmount), ACCOUNT_PUBKEY)).kind
    ).toBe("unreadable");

    const badLamports = parsedNativeRead({ lamports: -5 });
    expect(
      (await readNativeAccountState(connectionReading(badLamports), ACCOUNT_PUBKEY)).kind
    ).toBe("unreadable");

    const badState = parsedNativeRead({ state: "uninitialized" });
    expect(
      (await readNativeAccountState(connectionReading(badState), ACCOUNT_PUBKEY)).kind
    ).toBe("unreadable");
  });

  it("records an omitted isNative as unknown and omitted authorities as null", async () => {
    const response = parsedNativeRead({ delegate: null, closeAuthority: null });
    const info = (
      response.value.data as {
        parsed: { info: Record<string, unknown> };
      }
    ).parsed.info;
    delete info.isNative;
    const read = await readNativeAccountState(
      connectionReading(response),
      cleanCandidate().pubkey
    );
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(read.nativeStatus).toBe("unknown");
    expect(read.delegate).toBeNull();
    expect(read.closeAuthority).toBeNull();
  });
});

describe("evaluateNativeGate (§8.3)", () => {
  const passRead = (): Extract<NativeAccountRead, { kind: "read" }> => ({
    kind: "read",
    program: "spl",
    walletOwner: OWNER.toBase58(),
    mint: SPL_NATIVE_MINT,
    state: "initialized",
    nativeStatus: "native",
    amount: "250000000",
    decimals: 9,
    lamports: 2488440,
    closeAuthority: null,
    delegate: null,
  });

  it("passes with the before-action figures and live delegate evidence", () => {
    const verdict = evaluateNativeGate(
      { ...passRead(), amount: "7", lamports: 2000000, delegate: "Del" },
      SPL_NATIVE_MINT,
      OWNER.toBase58()
    );
    expect(verdict).toEqual({
      kind: "pass",
      amountBeforeAction: "7",
      lamportsBeforeAction: 2000000,
      delegate: "Del",
    });
  });

  it("maps a missing account to already-closed (row 1)", () => {
    expect(
      evaluateNativeGate({ kind: "missing" }, SPL_NATIVE_MINT, OWNER.toBase58())
    ).toEqual({ kind: "already-closed" });
  });

  it("aborts on every §8.3 hard block", () => {
    expect(
      evaluateNativeGate({ kind: "unreadable" }, SPL_NATIVE_MINT, OWNER.toBase58())
    ).toEqual({ kind: "abort", reason: "unreadable" });
    expect(
      evaluateNativeGate(
        { ...passRead(), walletOwner: Keypair.generate().publicKey.toBase58() },
        SPL_NATIVE_MINT,
        OWNER.toBase58()
      )
    ).toEqual({ kind: "abort", reason: "foreign-owner" });
    expect(
      evaluateNativeGate(
        {
          ...passRead(),
          closeAuthority: Keypair.generate().publicKey.toBase58(),
        },
        SPL_NATIVE_MINT,
        OWNER.toBase58()
      )
    ).toEqual({ kind: "abort", reason: "foreign-close-authority" });
    expect(
      evaluateNativeGate(
        { ...passRead(), state: "frozen" },
        SPL_NATIVE_MINT,
        OWNER.toBase58()
      )
    ).toEqual({ kind: "abort", reason: "impossible-frozen" });
    expect(
      evaluateNativeGate(
        { ...passRead(), nativeStatus: "non-native" },
        SPL_NATIVE_MINT,
        OWNER.toBase58()
      )
    ).toEqual({ kind: "abort", reason: "native-status-lost" });
    expect(
      evaluateNativeGate(
        { ...passRead(), nativeStatus: "unknown" },
        SPL_NATIVE_MINT,
        OWNER.toBase58()
      )
    ).toEqual({ kind: "abort", reason: "native-status-lost" });
    expect(
      evaluateNativeGate(
        { ...passRead(), mint: Keypair.generate().publicKey.toBase58() },
        SPL_NATIVE_MINT,
        OWNER.toBase58()
      )
    ).toEqual({ kind: "abort", reason: "mint-mismatch" });
  });

  it("does NOT abort on amount or lamports drift (Case B) nor on a delegate present", () => {
    const verdict = evaluateNativeGate(
      { ...passRead(), amount: "999", lamports: 1 },
      SPL_NATIVE_MINT,
      OWNER.toBase58()
    );
    expect(verdict.kind).toBe("pass");
    expect(
      evaluateNativeGate(
        { ...passRead(), delegate: "someone" },
        SPL_NATIVE_MINT,
        OWNER.toBase58()
      ).kind
    ).toBe("pass");
  });

  it("gives every abort reason a user-facing sentence", () => {
    for (const reason of Object.keys(NATIVE_GATE_ABORT_COPY)) {
      expect(
        NATIVE_GATE_ABORT_COPY[reason as keyof typeof NATIVE_GATE_ABORT_COPY]
      ).toMatch(/Nothing was signed\.|close the account now\.$/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* §10.2.9 — the import boundary                                       */
/* ------------------------------------------------------------------ */

const importStatements = (source: string) =>
  source.match(/^import[\s\S]*?from "[^"]+";/gm) ?? [];

describe("import boundary (§10.2.9)", () => {
  it("unwrapNative.ts imports only web3.js, the shipped spl-token builders, and tokenAccounts", () => {
    const imports = importStatements(
      readFileSync("src/lib/solana/unwrapNative.ts", "utf8")
    );
    const from = imports.map(
      (line) => line.match(/from "([^"]+)";/)?.[1] ?? ""
    );
    const allowed = new Set([
      "@solana/web3.js",
      "@solana/spl-token",
      "./tokenAccounts",
    ]);
    for (const source of from) {
      expect(allowed.has(source)).toBe(true);
    }
    expect(from).toContain("@solana/spl-token");
  });

  it("unwrapNative.ts imports no close/fee/action/inspection/React module (§10.2.5)", () => {
    const imports = importStatements(
      readFileSync("src/lib/solana/unwrapNative.ts", "utf8")
    );
    const joined = imports.join("\n");
    expect(joined).not.toMatch(
      /closeAccounts|fees|walletInspection|explain|postState|revokeDelegation|react|wallet-adapter|transactions/i
    );
  });

  it("the read-only layer imports nothing from the unwrap module", () => {
    const inspection = importStatements(
      readFileSync("src/lib/solana/walletInspection.ts", "utf8")
    );
    expect(inspection.join("\n")).not.toMatch(/unwrapNative|useUnwrapNative/);
    const summary = importStatements(
      readFileSync("src/components/WalletStateSummary.tsx", "utf8")
    );
    expect(summary.join("\n")).not.toMatch(
      /unwrapNative|useUnwrapNative|actionMutex/
    );
  });

  it("exactly the three action hooks import the action mutex", () => {
    const hooks = readdirSync("src/hooks").filter((f) => f.endsWith(".ts"));
    const importers = hooks.filter((f) =>
      importStatements(readFileSync(`src/hooks/${f}`, "utf8")).some((line) =>
        line.includes("@/lib/actionMutex")
      )
    );
    expect(importers.sort()).toEqual(
      ["useRepairWallet.ts", "useRevokeDelegate.ts", "useUnwrapNative.ts"].sort()
    );
  });
});
