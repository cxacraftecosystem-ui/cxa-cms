import { ImageResponse } from "next/og";

/**
 * The iOS home-screen icon, generated rather than committed as a PNG.
 *
 * iOS ignores SVG favicons, so `app/icon.svg` alone leaves a bookmarked site showing a screenshot of
 * the page instead of a mark. Generating it here keeps ONE definition of the mark: change the
 * geometry in `app/icon.svg` and mirror it below, rather than re-exporting a binary that nobody can
 * diff and everybody forgets.
 *
 * `size` and `contentType` are read by Next at build time to write the correct `<link rel>` tag.
 * 180×180 is the size iOS actually requests; anything else is downscaled by the device, badly.
 *
 * ⚠ No rounded corners and no transparency: iOS applies its own mask, and a pre-rounded icon comes
 * out with a visible double-rounded edge.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          // purple-700 as sRGB — `next/og` renders with Satori, which does not resolve oklch().
          background: "#5B21B6"
        }}
      >
        <svg width="180" height="180" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r="15" fill="none" stroke="#FAF9F5" strokeWidth="3" opacity="0.92" />
          <circle cx="32" cy="32" r="5.5" fill="#FAF9F5" />
          <g stroke="#FAF9F5" strokeWidth="3" strokeLinecap="round" opacity="0.92">
            <line x1="32" y1="7" x2="32" y2="13" />
            <line x1="32" y1="51" x2="32" y2="57" />
            <line x1="7" y1="32" x2="13" y2="32" />
          </g>
          <line x1="51" y1="32" x2="57" y2="32" stroke="#E8B23A" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </div>
    ),
    size
  );
}
