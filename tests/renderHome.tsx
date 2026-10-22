/**
 * Test helper: render the homepage and wait for the lazily loaded
 * wallet app (HomeApp) to mount behind the connect boundary.
 *
 * The homepage reaches the wallet only through next/dynamic (pinned in
 * page.lazyBoundary.test.tsx), so the wallet UI appears one tick after
 * the placeholder, in every environment - including this one. The
 * readiness signal works for both wallet states a test can arrange:
 * the connected-address box ("Connected:") when a public key is set,
 * or the real Select Wallet control when none is.
 *
 * Existing page tests swap their render(<Home />) call for
 * await renderHome() and keep every assertion unchanged.
 */

import { render, screen, waitFor } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

import Home from "../src/app/page";

export async function renderHome(
  ui: ReactElement = <Home />
): Promise<RenderResult> {
  const result = render(ui);
  await waitFor(
    () => {
      const mounted =
        screen.queryByText("Connected:") ??
        screen.queryByRole("button", { name: /select wallet/i });
      if (!mounted) {
        throw new Error("HomeApp has not mounted behind the boundary yet");
      }
    },
    { timeout: 15000 }
  );
  return result;
}
