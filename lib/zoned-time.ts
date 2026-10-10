/**
 * Wall-clock times on the Centre's clock, for a `YYYY-MM-DDTHH:mm` date-and-time box.
 *
 * The same construction as `toZonedInput`/`fromZonedInput` in app/studio/events/[id]/EventEditor.tsx,
 * which sets out the reasoning (a date box has no zone of its own; `new Date("…T16:00")` is read as the
 * BROWSER's zone; the offset correction is applied twice so a daylight-saving boundary converges). Pure and
 * client-safe.
 */

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second")
  };
}

function offsetAt(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

/** An ISO instant as `YYYY-MM-DDTHH:mm` on the given zone's clock. `""` for nothing. */
export function toZonedInput(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const p = zonedParts(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** `YYYY-MM-DDTHH:mm` read as the given zone's clock, back to an ISO instant, or null. */
export function fromZonedInput(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  const firstPass = wall - offsetAt(new Date(wall), timeZone);
  const secondPass = wall - offsetAt(new Date(firstPass), timeZone);
  const instant = new Date(secondPass);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}
