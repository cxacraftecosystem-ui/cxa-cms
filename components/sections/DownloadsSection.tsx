/**
 * DownloadsSection — files from the file store, with their type, size and version.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY LINK GOES TO `/api/public/files/[slug]`, AND IT IS A PLAIN `<a>`.
 *
 * Two decisions, both load-bearing:
 *
 *   • The route, not the object URL, because the download count is recorded SERVER-SIDE as the bytes
 *     are served. A client beacon fired from an `onClick` is eaten by every ad blocker and by every
 *     reader who middle-clicks, so the figure it produces is not a figure anybody can report on. The
 *     route is also where `isPublic` and `expiresAt` are enforced — hiding a link is not an access
 *     control (contract §1.7), so the resolver's filter and the route's check are the same predicate
 *     written twice on purpose.
 *   • A plain `<a>` and never `next/link`, because the destination answers with a file. The client
 *     router would ask it for an RSC payload and get a PDF.
 *
 * THE SIZE IS SHOWN SO NOBODY STARTS A 40 MB DOWNLOAD ON A PHONE BY ACCIDENT. That is the whole
 * reason `showFileSize` defaults to on, and why a file with no version row says so rather than
 * rendering a blank size — "we do not know" and "it is small" must not look the same.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A Server Component.
 */

import Link from "next/link";
import type { PageSection } from "@prisma/client";
import {
  ArrowRight,
  Download,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Presentation,
  type LucideIcon
} from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { SectionHeading } from "@/components/site/SectionHeading";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { pickShowcase, type FileRow, type ResolvedSectionData } from "@/lib/sections/resolve";
import type { DownloadsSectionData } from "@/lib/sections/schema";
import { formatBytes, truncateWords } from "@/lib/utils";

export interface DownloadsSectionProps {
  data: DownloadsSectionData;
  section: PageSection;
  /** The whole batched read from `lib/sections/resolve.ts`; this block's rows are pulled out by id. */
  resolved?: ResolvedSectionData;
  /** The rows directly, for a studio preview or a bespoke page. Wins over `resolved` when given. */
  rows?: FileRow[];
  total?: number;
  droppedIds?: number;
}

const FMT_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC"
});

/**
 * The extension, lowercased, from a filename.
 *
 * Reimplemented in three lines rather than imported from lib/storage/keys.ts, which pulls in
 * `node:crypto` for key generation — a dependency a public card has no business carrying.
 */
function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  if (index <= 0 || index === fileName.length - 1) return "";
  return fileName.slice(index + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The glyph, chosen from the extension rather than the MIME type.
 *
 * A MIME type is often `application/octet-stream` for exactly the files whose shape matters most — a
 * dataset, a 3D model, an archive — whereas the extension is the thing an editor actually named.
 * Unknown extensions get the generic document glyph, which is honest.
 */
const EXTENSION_ICON: Record<string, LucideIcon> = {
  pdf: FileText,
  doc: FileText,
  docx: FileText,
  txt: FileText,
  md: FileText,
  rtf: FileText,
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  ods: FileSpreadsheet,
  zip: FileArchive,
  gz: FileArchive,
  tar: FileArchive,
  "7z": FileArchive,
  rar: FileArchive,
  ppt: Presentation,
  pptx: Presentation,
  key: Presentation,
  json: FileCode,
  xml: FileCode,
  geojson: FileCode,
  glb: FileCode,
  gltf: FileCode,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  webp: FileImage,
  svg: FileImage,
  tif: FileImage,
  tiff: FileImage
};

interface FileFacts {
  /** "PDF", "CSV" — the extension a reader recognises, or null when there is no version at all. */
  format: string | null;
  size: string | null;
  version: number | null;
  icon: LucideIcon;
}

function factsOf(file: FileRow): FileFacts {
  // The resolver selects only the NEWEST version (`take: 1` on a descending order), so index 0 is
  // the one a click would fetch. Under `noUncheckedIndexedAccess` this is `| undefined`, which is
  // also the real state of a file whose upload never completed.
  const latest = file.versions[0];
  if (!latest) return { format: null, size: null, version: null, icon: FileText };

  const extension = extensionOf(latest.fileName);
  return {
    format: extension ? extension.toUpperCase() : null,
    size: formatBytes(latest.byteSize),
    version: latest.version,
    icon: EXTENSION_ICON[extension] ?? FileText
  };
}

export function DownloadsSection({
  data,
  section,
  resolved,
  rows: given,
  total: givenTotal,
  droppedIds: givenDropped
}: DownloadsSectionProps) {
  const { rows, total: matched, droppedIds } = pickShowcase(resolved?.files, section.id, {
    rows: given,
    total: givenTotal,
    droppedIds: givenDropped
  });

  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  const body = data.body.trim();
  const label = data.ctaLabel.trim();
  const href = data.ctaHref.trim();
  const link = label && href ? { href, label } : undefined;
  const showsHeader = Boolean(heading || eyebrow || body || link);
  const hidden = Math.max(0, matched - rows.length);
  const category = data.category.trim();

  return (
    <section id={`block-${section.id}`} className="py-20 md:py-28">
      <div className="shell">
        <Reveal>
          <SectionHeading
            eyebrow={eyebrow || undefined}
            title={heading || "Downloads"}
            titleClassName={heading ? undefined : "sr-only"}
            description={body || undefined}
            // ⚠ Withheld when the heading is off screen: `SectionHeading` gates its trailing link on
            // the link alone, so an `sr-only` title still paints it — and the row below would draw
            // the same call to action a second time. Exactly one of the two ever renders.
            link={heading ? link : undefined}
          />
        </Reveal>

        <div className={showsHeader ? "mt-12" : undefined}>
          {rows.length === 0 ? (
            <EmptyState
              icon={Download}
              title={category ? `No files in ${category} yet` : "No files to download yet"}
              description="Files appear here once they are uploaded and marked public in the studio."
              headingLevel={3}
            />
          ) : (
            <ul className="grid gap-3">
              {rows.map((file, index) => (
                <li key={file.id}>
                  <Reveal delay={Math.min(index, 8) * 0.05}>
                    <FileRowItem
                      file={file}
                      showFileSize={data.showFileSize}
                      showUpdatedOn={data.showUpdatedOn}
                    />
                  </Reveal>
                </li>
              ))}
            </ul>
          )}
        </div>

        <ShowcaseNote hidden={hidden} matched={matched} dropped={droppedIds} link={link} />

        {/* The CTA's one copy when the heading is off screen — see the note beside `SectionHeading`. */}
        {!heading && link ? (
          <div className="mt-10">
            <LinkButton href={link.href} variant="secondary" icon={ArrowRight} iconPosition="end">
              {link.label}
            </LinkButton>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function FileRowItem({
  file,
  showFileSize,
  showUpdatedOn
}: {
  file: FileRow;
  showFileSize: boolean;
  showUpdatedOn: boolean;
}) {
  const facts = factsOf(file);
  const Icon = facts.icon;

  // The whole row is one link and there is nothing else interactive inside it, so an anchor WRAPPING
  // the row is correct here — unlike EntityCard, which needs an overlay precisely because its cards
  // carry a second link.
  return (
    <a
      href={`/api/public/files/${file.slug}`}
      className="group flex items-start gap-4 rounded-md border border-line-200 bg-card p-4 transition duration-200 ease-out hover:-translate-y-0.5 hover:border-purple-200 hover:shadow-md active:translate-y-0 active:shadow-sm"
    >
      <span className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-purple-50 text-purple-700">
        <Icon aria-hidden="true" className="h-5 w-5" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="display-title block text-balance text-base leading-snug transition-colors group-hover:text-purple-700">
          {file.title}
        </span>

        {file.description?.trim() ? (
          <span className="mt-1 block text-sm leading-relaxed text-ink-500">
            {truncateWords(file.description, 180)}
          </span>
        ) : null}

        <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-500">
          {facts.format ? <Badge size="sm">{facts.format}</Badge> : null}

          {showFileSize ? (
            facts.size ? (
              <span className="tabular-nums">{facts.size}</span>
            ) : (
              // "We do not know" and "it is small" must not look the same. A file with no version row
              // has nothing uploaded against it yet, and saying so is the only honest option.
              <span>Size not recorded</span>
            )
          ) : null}

          {facts.version !== null ? (
            <span className="tabular-nums">Version {facts.version}</span>
          ) : null}

          {file.category?.trim() ? <span>{file.category}</span> : null}

          {showUpdatedOn ? (
            <span>
              Updated{" "}
              <time dateTime={file.updatedAt.toISOString()}>{FMT_DATE.format(file.updatedAt)}</time>
            </span>
          ) : null}
        </span>
      </span>

      <Download
        aria-hidden="true"
        className="mt-1 h-5 w-5 shrink-0 text-ink-300 transition-colors group-hover:text-purple-700"
      />
    </a>
  );
}

/** The honest footnote — contract §1.6. */
function ShowcaseNote({
  hidden,
  matched,
  dropped,
  link
}: {
  hidden: number;
  matched: number;
  dropped: number;
  link?: { href: string; label: string };
}) {
  if (hidden === 0 && dropped === 0) return null;

  return (
    <p className="mt-8 text-sm text-ink-500">
      {hidden > 0 ? (
        <>
          Showing {matched - hidden} of {matched} files.{" "}
          {link ? (
            <Link href={link.href} className="font-medium text-purple-700 hover:text-purple-800">
              {link.label}
            </Link>
          ) : null}
        </>
      ) : null}
      {dropped > 0 ? (
        <>
          {hidden > 0 ? " " : null}
          {dropped} chosen {dropped === 1 ? "file is" : "files are"} no longer public and{" "}
          {dropped === 1 ? "is" : "are"} not shown.
        </>
      ) : null}
    </p>
  );
}
