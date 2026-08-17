import "server-only";

/**
 * Convert an office document to PDF, so the browser's own viewer can show it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS, AND WHY IT CONVERTS AT UPLOAD RATHER THAN AT VIEW.
 *
 * No browser renders Word or PowerPoint. `components/sections/DocumentEmbedSection.tsx` therefore frames a
 * PDF natively — the browser's own viewer, no dependency — and shows a labelled download card for
 * everything else, and its header explains at length why it refuses to embed Office Online or Google's
 * Docs Viewer: both render a deck by fetching it FROM OUR STORAGE INTO THEIRS, from a public URL, on every
 * page load, cached indefinitely — including a document withdrawn an hour later.
 *
 * Converting once, here, keeps that objection answered while still showing the document. The third party
 * sees the bytes ONE time, from our server, on an upload an editor performed deliberately; readers are
 * then served a static PDF from our own CDN, which is faster than any viewer and costs no function time.
 * It also means ONE reader-facing path instead of three, reusing the PDF frame that already exists — and
 * that frame already solves two traps worth not re-solving (an `<object>` is blocked by our own
 * `object-src 'none'`, and Chrome's PDF viewer refuses to render inside a sandboxed frame).
 *
 * ⚠ A CONVERSION FAILURE IS NOT AN UPLOAD FAILURE, and this module never throws for one. Every expected
 * problem — no key configured, a format nobody can convert, a provider outage, a corrupt file, a timeout —
 * comes back as `{ ok: false, reason }`. The document still uploads and still gets its download card,
 * exactly as before this existed. A preview is an ENHANCEMENT; making it a gate on getting a file into the
 * library would be a worse product than having no preview at all.
 *
 * ⚠ IT IS ALSO ENTIRELY OPTIONAL. With no `CLOUDCONVERT_API_KEY` the whole feature is inert and the
 * studio behaves as it does today. That is what makes this safe to deploy before anybody has decided
 * whether to keep paying for a converter.
 *
 * WHY NOT LIBREOFFICE IN THE RUNTIME. `soffice --headless --convert-to pdf` needs a several-hundred-megabyte
 * install; Vercel's 5 GB package limit now makes that technically possible, so the old note in
 * DocumentEmbedSection saying it "cannot run on a serverless function" is out of date. It is still the
 * wrong choice here: cold starts of that size, tens of seconds of CPU per deck on a shared tier, and the
 * font problem that note names — a deck converted without its typefaces reflows and comes out wrong, which
 * is worse than a download card. A hosted converter ships with fonts.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** The provider's base. Written out rather than configurable: one provider, named in the file. */
const API = "https://api.cloudconvert.com/v2";

/**
 * How long a whole conversion may take before we give up and leave the download card in place.
 *
 * Generous, because a large deck genuinely takes tens of seconds, and the caller is a route an editor is
 * watching rather than a page a reader is waiting for. Comfortably inside a function's own budget.
 */
const DEADLINE_MS = 120_000;

/** Poll interval. Starts short because a small document is often finished in two or three seconds. */
const POLL_START_MS = 1_500;
const POLL_MAX_MS = 6_000;

/**
 * The extensions worth offering a preview for.
 *
 * ⚠ EXTENSION, NOT STORED MIME TYPE, for the reason `DownloadsSection` and `documentFormat` both give: a
 * stored content type is whatever the uploading browser guessed, and browsers guess Office formats
 * particularly badly — a `.docx` routinely arrives as `application/zip` or `application/octet-stream`.
 * The extension is what an editor actually named the file.
 *
 * `pdf` is deliberately ABSENT. A PDF needs no conversion; it is already the thing every other format is
 * being converted into, and asking a provider to convert it would spend a quota entry to produce a copy.
 */
export const PDF_CONVERTIBLE_EXTENSIONS = [
  "docx",
  "doc",
  "pptx",
  "ppt",
  "odt",
  "odp",
  "ods",
  "rtf",
  "xlsx",
  "xls",
  "csv",
  "txt"
] as const;

export type PdfConvertibleExtension = (typeof PDF_CONVERTIBLE_EXTENSIONS)[number];

/** The convertible extension of a file name, or null when a preview is not on offer for it. */
export function pdfConvertibleExtension(fileName: string): PdfConvertibleExtension | null {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  const extension = match?.[1]?.toLowerCase();
  if (!extension) return null;
  return (PDF_CONVERTIBLE_EXTENSIONS as readonly string[]).includes(extension)
    ? (extension as PdfConvertibleExtension)
    : null;
}

/** Is a converter configured at all? Everything downstream must treat false as "no preview, no error". */
export function documentConverterConfigured(): boolean {
  return (process.env.CLOUDCONVERT_API_KEY ?? "").trim().length > 0;
}

export type ConversionResult =
  | { ok: true; pdf: Buffer; seconds: number }
  | { ok: false; reason: string };

interface JobTask {
  id: string;
  name: string;
  operation: string;
  status: string;
  message?: string | null;
  result?: { form?: { url: string; parameters: Record<string, string> }; files?: { filename: string; url: string }[] };
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${(process.env.CLOUDCONVERT_API_KEY ?? "").trim()}`,
      accept: "application/json",
      ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...init.headers
    },
    cache: "no-store"
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    // The provider's own message where it gave one — it names a quota or an unsupported format, and
    // "HTTP 402" alone would send an operator looking in the wrong place.
    const message =
      (body as { message?: string } | null)?.message ?? `the converter answered HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function tasksOf(job: unknown): JobTask[] {
  const data = (job as { data?: { tasks?: JobTask[] } } | null)?.data;
  return data?.tasks ?? [];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Convert `bytes` to PDF.
 *
 * Four steps, and the shape of each is written out because the provider's own documentation describes a
 * dozen variants of this flow and only one of them is in use here:
 *
 *   1. POST /jobs           — three tasks: an upload slot, the conversion, a download URL.
 *   2. POST <the upload form> — the bytes, as multipart, to the URL the import task hands back.
 *   3. GET  /jobs/{id}      — polled until the job finishes or fails.
 *   4. GET  <the export URL> — the finished PDF.
 *
 * ⚠ `import/upload` RATHER THAN `import/url`. Passing a URL would be one fewer request, and would require
 * every convertible document to be publicly readable so the provider could fetch it — which is exactly the
 * property the file store deliberately does not have (`FileAsset.isPublic` defaults to false, and the
 * download route enforces it server-side). Uploading the bytes keeps an embargoed document embargoed.
 */
export async function convertToPdf(input: { bytes: Uint8Array; fileName: string }): Promise<ConversionResult> {
  if (!documentConverterConfigured()) {
    return { ok: false, reason: "No document converter is configured, so no preview was made." };
  }
  const extension = pdfConvertibleExtension(input.fileName);
  if (!extension) {
    return { ok: false, reason: "That format cannot be converted to a PDF preview." };
  }

  const started = Date.now();
  const remaining = () => DEADLINE_MS - (Date.now() - started);

  try {
    const job = await api("/jobs", {
      method: "POST",
      body: JSON.stringify({
        tasks: {
          "cxa-import": { operation: "import/upload" },
          "cxa-convert": {
            operation: "convert",
            input: "cxa-import",
            input_format: extension,
            output_format: "pdf"
          },
          "cxa-export": { operation: "export/url", input: "cxa-convert" }
        },
        tag: "cxa-portal-document-preview"
      })
    });

    const jobId = (job as { data?: { id?: string } }).data?.id;
    if (!jobId) return { ok: false, reason: "The converter did not open a job." };

    // ── 2. the bytes ────────────────────────────────────────────────────────
    const importTask = tasksOf(job).find((task) => task.name === "cxa-import");
    const form = importTask?.result?.form;
    if (!form) return { ok: false, reason: "The converter did not offer an upload slot." };

    const body = new FormData();
    for (const [key, value] of Object.entries(form.parameters)) body.append(key, value);
    // A fresh ArrayBuffer, because a Buffer from Prisma or S3 may be a VIEW over a larger pool and
    // `new Blob([view])` would otherwise carry the whole pool.
    const copy = new Uint8Array(input.bytes.byteLength);
    copy.set(input.bytes);
    body.append("file", new Blob([copy]), input.fileName);

    const upload = await fetch(form.url, { method: "POST", body, cache: "no-store" });
    if (!upload.ok) return { ok: false, reason: `The upload to the converter failed (HTTP ${upload.status}).` };

    // ── 3. wait ─────────────────────────────────────────────────────────────
    let wait = POLL_START_MS;
    for (;;) {
      if (remaining() <= 0) {
        return { ok: false, reason: "The conversion took too long, so no preview was made." };
      }
      await sleep(Math.min(wait, Math.max(remaining(), 0)));
      wait = Math.min(Math.round(wait * 1.5), POLL_MAX_MS);

      const polled = await api(`/jobs/${jobId}`);
      const status = (polled as { data?: { status?: string } }).data?.status;
      if (status === "error") {
        const failed = tasksOf(polled).find((task) => task.status === "error");
        return { ok: false, reason: failed?.message?.trim() || "The converter could not read that file." };
      }
      if (status !== "finished") continue;

      // ── 4. the PDF ────────────────────────────────────────────────────────
      const exported = tasksOf(polled).find((task) => task.name === "cxa-export");
      const url = exported?.result?.files?.[0]?.url;
      if (!url) return { ok: false, reason: "The conversion finished but produced no file." };

      const pdf = await fetch(url, { cache: "no-store" });
      if (!pdf.ok) return { ok: false, reason: `The finished PDF could not be fetched (HTTP ${pdf.status}).` };
      const buffer = Buffer.from(await pdf.arrayBuffer());

      // A PDF starts "%PDF-". Checked because storing something that is not a PDF under a key the
      // renderer will frame produces a blank viewer, which is the failure this whole feature exists to
      // avoid — and a download card is a better answer than an empty frame.
      if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
        return { ok: false, reason: "The converter returned something that is not a PDF." };
      }

      return { ok: true, pdf: buffer, seconds: Math.round((Date.now() - started) / 100) / 10 };
    }
  } catch (error) {
    // Logged for an operator, summarised for the editor. The provider's messages name quotas and
    // unsupported formats, which are things an editor can act on, so the message is passed through.
    console.error("[documents] conversion failed", input.fileName, error);
    return {
      ok: false,
      reason: error instanceof Error && error.message ? error.message : "The converter could not be reached."
    };
  }
}
