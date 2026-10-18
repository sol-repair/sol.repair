// @vitest-environment jsdom

/**
 * Authority labels, mint names, and the guidance block in the wallet
 * state summary (the authority-naming v2 spec, section 3.3 and 3.5).
 *
 * The labels are observations, never verdicts: the system program gets
 * the registry label, an imitation address gets the imitation label
 * (which never claims it cannot sign), and every other address gets
 * nothing. Mint names render only where the scan carried them, as
 * self-declared text, and the guidance block renders verbatim under
 * both authority lists. Presentation only: the component still imports
 * no wallet adapter and no action-bearing module, and the no-fetch line
 * (no new fetch() anywhere in src/) is pinned here because this is the
 * surface the privacy promise is stated on.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";

import {
  summarizeWalletState,
} from "@/lib/solana/walletInspection";
import { WalletStateSummary } from "@/components/WalletStateSummary";
import type {
  ScanResult,
  SkippedAccount,
} from "@/lib/solana/tokenAccounts";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const SYSTEM_PROGRAM_LABEL =
  "the system program. It cannot sign a token-account close.";
const IMITATION_LABEL =
  "imitates the system program. It is not the system program.";
const IMITATION_ADDRESS =
  "111111111111AbCdEfGhIjKlMnOpQrStUvWxYz23456789";
const ORDINARY_AUTHORITY = Keypair.generate().publicKey.toBase58();

afterEach(cleanup);

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
 *  skip with the given authority evidence. */
function renderForeignCA(entry: Partial<SkippedAccount>) {
  const summary = summarizeWalletState(
    scan({
      totalAccounts: 1,
      skippedAccounts: [
        skip({
          cause: "close-authority",
          reason: "close authority belongs to another address",
          closeAuthority: entry.closeAuthority,
          ...entry,
        }),
      ],
    })
  );
  return render(<WalletStateSummary summary={summary} />);
}

describe("authority labels in the grouped lists", () => {
  it("labels the system program with the registry label, never the imitation label", () => {
    const { container } = renderForeignCA({ closeAuthority: SYSTEM_PROGRAM });
    expect(screen.getAllByText(SYSTEM_PROGRAM_LABEL).length).toBe(1);
    expect(container.textContent).not.toContain(IMITATION_LABEL);
  });

  it("labels a 12-leading-one imitation address, which is a real pubkey", () => {
    renderForeignCA({ closeAuthority: IMITATION_ADDRESS });
    expect(screen.getAllByText(IMITATION_LABEL).length).toBe(1);
    expect(screen.queryByText(SYSTEM_PROGRAM_LABEL)).toBeNull();
  });

  it("gives an ordinary foreign authority no label", () => {
    const { container } = renderForeignCA({
      closeAuthority: ORDINARY_AUTHORITY,
    });
    expect(container.textContent).not.toContain(SYSTEM_PROGRAM_LABEL);
    expect(container.textContent).not.toContain(IMITATION_LABEL);
  });

  it("labels the funded list's authorities too", () => {
    const summary = summarizeWalletState(
      scan({
        totalAccounts: 1,
        skippedAccounts: [
          skip({
            cause: "funded",
            reason: "holds a token balance",
            balance: "100",
            foreignCloseAuthority: true,
            closeAuthority: IMITATION_ADDRESS,
            mintName: "MomoCoin",
            mintSymbol: "MOMO",
          }),
        ],
      })
    );
    render(<WalletStateSummary summary={summary} />);
    expect(screen.getAllByText(IMITATION_LABEL).length).toBe(1);
  });
});

describe("mint names render as self-declared text", () => {
  it("renders the name and symbol after the mint link, where carried", () => {
    renderForeignCA({
      closeAuthority: IMITATION_ADDRESS,
      mint: Keypair.generate().publicKey.toBase58(),
      mintName: "MomoCoin",
      mintSymbol: "MOMO",
    });
    expect(screen.getAllByText(/MomoCoin/).length).toBe(1);
    expect(screen.getAllByText(/MOMO/).length).toBe(1);
  });

  it("renders no mint name where none was carried", () => {
    const { container } = renderForeignCA({
      closeAuthority: IMITATION_ADDRESS,
      mint: Keypair.generate().publicKey.toBase58(),
    });
    expect(container.textContent).not.toContain("MomoCoin");
  });

  it("never phrases mint metadata as identity or endorsement", () => {
    // The render must add no trust language around the name: the
    // self-declared text is all that may appear.
    const { container } = renderForeignCA({
      closeAuthority: IMITATION_ADDRESS,
      mint: Keypair.generate().publicKey.toBase58(),
      mintName: "MomoCoin",
      mintSymbol: "MOMO",
    });
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/verified|official|endorsed/);
    expect(text).toContain("MomoCoin");
  });
});

describe("the guidance block", () => {
  it("renders verbatim under both authority lists", () => {
    const summary = summarizeWalletState(
      scan({
        totalAccounts: 2,
        skippedAccounts: [
          skip({
            pubkey: "EMPTY-FOREIGN",
            cause: "close-authority",
            reason: "close authority belongs to another address",
            closeAuthority: IMITATION_ADDRESS,
          }),
          skip({
            pubkey: "FUNDED-FOREIGN",
            cause: "funded",
            reason: "holds a token balance",
            balance: "100",
            foreignCloseAuthority: true,
            closeAuthority: SYSTEM_PROGRAM,
          }),
        ],
      })
    );
    render(<WalletStateSummary summary={summary} />);
    const guidance = screen.getAllByText(
      /Only the close authority can sign a close\. If it is not a wallet you control, the rent in these accounts cannot be recovered by you, and no tool can change that\. Beware any service claiming to unlock these accounts\./
    );
    expect(guidance.length).toBe(2);
  });

  it("is absent when no foreign-close-authority finding exists", () => {
    const summary = summarizeWalletState(
      scan({
        totalAccounts: 1,
        eligibleAccounts: [
          {
            pubkey: "OK",
            mint: "MINT",
            lamports: 2039280,
            program: "spl",
          },
        ],
      })
    );
    const { container } = render(<WalletStateSummary summary={summary} />);
    expect(container.textContent).not.toContain(
      "Only the close authority can sign a close."
    );
  });
});

describe("the labels stay observations, not verdicts", () => {
  it("contains no scam or safe judgment anywhere new", () => {
    const { container } = renderForeignCA({ closeAuthority: IMITATION_ADDRESS });
    expect(container.textContent).not.toMatch(/scam/i);
    // "safe" appears in no label; the summary's own lines never add it.
    expect(container.textContent).not.toMatch(/safe/i);
  });

  it("keeps the owner writing rules on the labels and guidance", () => {
    const texts = [
      SYSTEM_PROGRAM_LABEL,
      IMITATION_LABEL,
      "Only the close authority can sign a close. If it is not a wallet you control, the rent in these accounts cannot be recovered by you, and no tool can change that. Beware any service claiming to unlock these accounts.",
    ];
    for (const text of texts) {
      expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
      expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
      expect(text.includes("!")).toBe(false);
    }
  });
});

describe("read-only boundaries hold", () => {
  it("the summary component imports no wallet adapter and no action-bearing module", () => {
    const importStatements = (source: string) =>
      source.match(/^import[\s\S]*?from "[^"]+";/gm) ?? [];
    const componentImports = importStatements(
      fs.readFileSync("src/components/WalletStateSummary.tsx", "utf8")
    );
    expect(componentImports.join("\n")).not.toMatch(
      /wallet-adapter|useRepairWallet|solana\/(closeAccounts|fees|transactions)/
    );
  });

  it("the decode module imports nothing action-bearing and nothing signs or sends", () => {
    const importStatements = (source: string) =>
      source.match(/^import[\s\S]*?from "[^"]+";/gm) ?? [];
    const moduleImports = importStatements(
      fs.readFileSync("src/lib/solana/authorityNaming.ts", "utf8")
    );
    expect(moduleImports.join("\n")).not.toMatch(
      /wallet-adapter|useRepairWallet|solana\/(closeAccounts|fees|transactions|revokeDelegation|unwrapNative|burnDust|excessLamports)/
    );
    const source = fs.readFileSync("src/lib/solana/authorityNaming.ts", "utf8");
    expect(source).not.toMatch(/signTransaction|sendRawTransaction|sendTransaction/);
  });

  it("no new fetch() appears in src/ (the no-third-party-fetch line)", () => {
    // The fee ledger's own RPC fetch is the one legitimate call site.
    // The set of files containing fetch() must never grow: a new fetch
    // anywhere in src/ would be a new place wallet data could leave the
    // app's own RPC path.
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
      }
      return out;
    };
    const normalize = (file: string) => file.split(path.sep).join("/");
    const fetchFiles = walk("src")
      .filter((file) => /\bfetch\(/.test(fs.readFileSync(file, "utf8")))
      .map(normalize)
      .sort();
    expect(fetchFiles).toEqual(["src/lib/solana/feeLedger.ts"]);
  });
});
