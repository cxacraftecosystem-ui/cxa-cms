import { ImageResponse } from "next/og";
import { siteName } from "@/lib/env";

/**
 * The default social card.
 *
 * Generated rather than committed, so it always carries the CURRENT institution name — a committed
 * PNG goes stale the day the Centre is renamed and nobody notices, because nobody on the team ever
 * sees their own site's link preview.
 *
 * Individual pages override this with their own image through `pageMetadata()`; this is the fallback
 * for everything that has none, and for the site root. A link with no card image renders as a bare
 * grey rectangle on every platform that matters, which reads as a dead link.
 *
 * ⚠ Satori (what `next/og` renders with) supports a SUBSET of CSS. No `oklch()`, no CSS variables,
 * no `gap` on block layout, and every element that contains more than one child needs an explicit
 * `display: flex`. Colours below are therefore the sRGB equivalents of the brand ramp, written out.
 */
export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Centre of Excellence";

export default function OpengraphImage() {
  const name = siteName();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          background: "linear-gradient(135deg, #5B21B6 0%, #3B1878 55%, #2A1155 100%)",
          color: "#FFFFFF",
          fontFamily: "sans-serif"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
          <svg width="64" height="64" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="15" fill="none" stroke="#FAF9F5" strokeWidth="3" opacity="0.92" />
            <circle cx="32" cy="32" r="5.5" fill="#FAF9F5" />
            <g stroke="#FAF9F5" strokeWidth="3" strokeLinecap="round" opacity="0.92">
              <line x1="32" y1="7" x2="32" y2="13" />
              <line x1="32" y1="51" x2="32" y2="57" />
              <line x1="7" y1="32" x2="13" y2="32" />
            </g>
            <line x1="51" y1="32" x2="57" y2="32" stroke="#E8B23A" strokeWidth="3" strokeLinecap="round" />
          </svg>
          <div
            style={{
              display: "flex",
              fontSize: "22px",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "#E9D5FF"
            }}
          >
            Centre of Excellence
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: name.length > 40 ? "62px" : "82px",
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: "-0.02em"
            }}
          >
            {name}
          </div>
          <div
            style={{
              display: "flex",
              marginTop: "24px",
              fontSize: "30px",
              lineHeight: 1.4,
              color: "#D8C7F5",
              maxWidth: "900px"
            }}
          >
            Research, people, publications and a living archive.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "16px",
            fontSize: "24px",
            color: "#C4B0EA"
          }}
        >
          <div style={{ display: "flex", width: "48px", height: "3px", background: "#E8B23A" }} />
          <div style={{ display: "flex" }}>Documenting craft, at scale</div>
        </div>
      </div>
    ),
    size
  );
}
