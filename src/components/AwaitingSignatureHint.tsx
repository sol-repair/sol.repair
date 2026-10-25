"use client";

/**
 * AwaitingSignatureHint: one honest sentence on a card that has been
 * waiting for a wallet signature for a long, silent stretch.
 *
 * The missed-popup incident of 2026-09-27 (first production uses, the
 * unwrap flow): the wallet popup was missed or buried, the promise
 * never resolved, and the card waited forever with no guidance. The
 * fix is display-only: the parent renders this component only while
 * the card is in the awaiting-signature state, so after a silent
 * AWAITING_HINT_DELAY_MS it adds one sentence inside the live region.
 * Provable claims only: no approval has come through and this
 * transaction has not been sent. It points to the documented recovery
 * (reload the page, run the action again) and deliberately says
 * nothing about what approving a stale buried popup afterwards would
 * do; that depends on the blockhash window.
 *
 * The timer is cleared on unmount, which is also the state change: any
 * status move stops the parent from rendering this component and the
 * sentence disappears with it. No resend button, no auto-timeout, no
 * retry: the wait itself is untouched.
 */

import { useEffect, useState } from "react";

/** How long a silent wait earns the hint. */
export const AWAITING_HINT_DELAY_MS = 15000;

export const AWAITING_SIGNATURE_HINT =
  "No approval has come through after 15 seconds, and this transaction has not been sent. If the approval window is not open, reload the page and try again.";

export function AwaitingSignatureHint() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setVisible(true), AWAITING_HINT_DELAY_MS);
    return () => clearTimeout(id);
  }, []);
  if (!visible) {
    return null;
  }
  return (
    <p className="mt-2 text-xs leading-relaxed text-zinc-400">
      {AWAITING_SIGNATURE_HINT}
    </p>
  );
}
