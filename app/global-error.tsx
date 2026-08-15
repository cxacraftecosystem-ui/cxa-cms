"use client";

/**
 * The LAST-RESORT error boundary: it catches a failure in the root layout itself.
 *
 * Because the root layout is what failed, this component must render its OWN `<html>` and `<body>` —
 * nothing above it exists. That also means it cannot use anything the layout provides: no fonts, no
 * theme boot script, no providers, and **no Tailwind classes worth relying on**, since a failure
 * this deep may well be the stylesheet failing to load.
 *
 * So it is styled with inline styles and system fonts. It is deliberately plain. Its only job is to
 * not be a white screen.
 */
export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
          background: "#f7f6fb",
          color: "#1e1b2e",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif"
        }}
      >
        <main style={{ maxWidth: "34rem" }}>
          <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: "0 0 0.75rem" }}>
            The site could not start
          </h1>
          <p style={{ fontSize: "1rem", lineHeight: 1.7, margin: "0 0 1.5rem", color: "#3a3651" }}>
            Something failed before the page could be built. This is a fault on our side. Reloading
            sometimes clears it; if it does not, the reference below identifies what happened.
          </p>
          {error.digest ? (
            <p
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "0.875rem",
                color: "#615d7a",
                background: "#faf9fd",
                border: "1px solid #e4e2ef",
                borderRadius: "12px",
                padding: "0.75rem 1rem",
                margin: "0 0 1.5rem"
              }}
            >
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              appearance: "none",
              border: "none",
              cursor: "pointer",
              borderRadius: "12px",
              background: "#5B21B6",
              color: "#ffffff",
              font: "inherit",
              fontWeight: 500,
              padding: "0.625rem 1.25rem"
            }}
          >
            Reload the page
          </button>
        </main>
      </body>
    </html>
  );
}
