/**
 * StatusBadge — a `ContentStatus` as a chip, wearing an icon AND a word.
 *
 * The label and the tone come from `STATUS_LABELS` / `STATUS_TONES` in lib/content.ts, which is the
 * single place either is decided — a chip that says "Scheduled" in green while the list filter
 * treats SCHEDULED as not-yet-live is exactly the disagreement that map exists to prevent. (It is
 * `info`, not `success`, for that reason: a green chip on something that has not published is the
 * most misread signal in a CMS.)
 *
 * ⚠ ADDING A STATUS MUST NOT SILENTLY FALL THROUGH. `ContentStatus` is a Prisma enum: a new value
 * lands in the generated client and every `Record<ContentStatus, …>` in the codebase is a type error
 * — except at a call site compiled before the migration, or when a row arrives over JSON from an API
 * a deploy older than the database. The three lookups below are therefore treated as PARTIAL and
 * fall back to a humanised enum name ("IN_REVIEW" → "In review"), a neutral tone and a question
 * mark. A chip reading "In review" with an unfamiliar icon is a prompt to update this file; a blank
 * gap where a status should be is a bug that ships.
 */

import type { ContentStatus } from "@prisma/client";
import {
  Archive,
  CalendarClock,
  CircleCheck,
  CircleHelp,
  Eye,
  PencilLine,
  type LucideIcon
} from "lucide-react";

import { STATUS_LABELS, STATUS_TONES } from "@/lib/content";
import { Badge, type BadgeSize, type BadgeTone } from "@/components/ui/Badge";

/** The glyph half of every signal. Kept here, beside nothing else, so it cannot drift from a route. */
const STATUS_ICONS: Record<ContentStatus, LucideIcon> = {
  DRAFT: PencilLine,
  IN_REVIEW: Eye,
  SCHEDULED: CalendarClock,
  PUBLISHED: CircleCheck,
  ARCHIVED: Archive
};

/** "IN_REVIEW" → "In review". The last resort, never the normal path. */
function humaniseEnumName(value: string): string {
  const words = value.replace(/_/g, " ").trim().toLowerCase();
  if (words.length === 0) return "Unknown";
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export interface StatusBadgeProps {
  status: ContentStatus;
  size?: BadgeSize;
  className?: string;
}

export function StatusBadge({ status, size = "md", className }: StatusBadgeProps) {
  // The `Partial<>` views are the whole point: they force the `??` that a total Record would let
  // TypeScript optimise away, and a value the maps have never heard of is exactly the runtime case.
  const labels: Partial<Record<ContentStatus, string>> = STATUS_LABELS;
  const tones: Partial<Record<ContentStatus, BadgeTone>> = STATUS_TONES;
  const icons: Partial<Record<ContentStatus, LucideIcon>> = STATUS_ICONS;

  return (
    <Badge
      tone={tones[status] ?? "neutral"}
      size={size}
      icon={icons[status] ?? CircleHelp}
      className={className}
    >
      {labels[status] ?? humaniseEnumName(status)}
    </Badge>
  );
}
