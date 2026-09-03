"use client";

/**
 * The rent estimate calculator on the Solana rent guide page.
 *
 * Pure client-side math over the shared rent constant. No RPC, no
 * state beyond the count, nothing sent anywhere.
 */

import { useState } from "react";

import { estimateRentLamports, formatRentSol } from "@/lib/rent";

export function RentCalculator() {
  const [count, setCount] = useState("10");

  const parsed = Number.parseInt(count, 10);
  const estimate = count.trim() === "" ? null : estimateRentLamports(parsed);

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 p-4">
      <label
        htmlFor="rent-account-count"
        className="block font-mono text-[11px] uppercase tracking-wider text-zinc-400"
      >
        Empty token accounts
      </label>
      <input
        id="rent-account-count"
        type="text"
        inputMode="numeric"
        value={count}
        onChange={(e) =>
          setCount(e.target.value.replace(/[^0-9]/g, "").slice(0, 5))
        }
        className="mt-2 w-32 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-zinc-500"
      />
      <p className="mt-3 font-mono text-sm text-zinc-200">
        {estimate === null ? (
          <span className="text-zinc-500">
            Enter a count between 1 and 99,999.
          </span>
        ) : (
          <>
            About{" "}
            <span className="text-zinc-50">{formatRentSol(estimate)} SOL</span>{" "}
            in rent deposits
          </>
        )}
      </p>
    </div>
  );
}
