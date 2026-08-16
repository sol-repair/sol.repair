import { ImageResponse } from "next/og";

/**
 * Social share card (Open Graph / Twitter). Rendered at build time by
 * Next.js, no image asset to keep in sync. Matches the site: black
 * background, mono type, one green accent.
 */

export const alt = "SOL.repair - reclaim SOL from empty token accounts";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          backgroundColor: "#000000",
          padding: "80px",
          fontFamily: "monospace",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 28,
            color: "#10b981",
            letterSpacing: 4,
            marginBottom: 24,
          }}
        >
          SOL.repair
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 72,
            fontWeight: 700,
            color: "#fafafa",
            lineHeight: 1.1,
            marginBottom: 32,
          }}
        >
          Reclaim SOL from empty
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 72,
            fontWeight: 700,
            color: "#fafafa",
            lineHeight: 1.1,
            marginBottom: 40,
          }}
        >
          token accounts.
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 28,
            color: "#a1a1aa",
          }}
        >
          Non-custodial. You sign every transaction. 1% success fee.
        </div>
      </div>
    ),
    { ...size }
  );
}
