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
          // The mark's own cream ground, filling the tile. iOS masks the corners itself, so the
          // rounded rect from `app/icon.svg` is deliberately NOT drawn here — see the header note.
          background: "#FAF9F5"
        }}
      >
        <svg width="180" height="180" viewBox="0 0 108 108">
          <path
            d="M54 14l7 27 27-7-20 20 20 20-27-7-7 27-7-27-27 7 20-20-20-20 27 7z"
            fill="#CC785C"
          />
          <circle cx="54" cy="54" r="15" fill="#181715" />
        </svg>
      </div>
    ),
    size
  );
}
