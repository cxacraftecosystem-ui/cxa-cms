/**
 * Writes the Centre's postal address and map pin into the `contact` settings group.
 *
 * A one-off operator script rather than a seed change: `seedSettings()` (prisma/seed.ts:879-890)
 * deliberately NEVER overwrites a group that already exists — "never overwrite an administrator's
 * choices" — so editing the defaults there would do nothing to a database that has already been
 * seeded. This merges into whatever is stored, leaving every other field in the group alone.
 *
 * The same values can be typed into Studio → Settings → Contact by hand; this exists so they are
 * recorded, reviewable and repeatable rather than being a thing somebody once did in a form.
 *
 *   npx tsx scripts/set-centre-location.ts
 *
 * Reads DATABASE_URL from the environment. ⚠ Point it at the right database — `.env` in this repo
 * is the LOCAL development one, and Prisma prefers it over an exported variable, so pass the target
 * explicitly on the command line when writing to production.
 */

import { PrismaClient } from "@prisma/client";

import { contactSettingsSchema } from "../lib/settings/schema";

const prisma = new PrismaClient();

/**
 * From the Centre's own Google Maps pin, https://maps.app.goo.gl/gTVqa7vBTGgf4tBc6, which resolves
 * to "A B I F IIT Kharagpur".
 *
 * ⚠ THE COORDINATES ARE THE PLACE MARKER, NOT THE MAP CENTRE. A resolved Maps URL carries both:
 * `@22.3132798,87.3110919` is where the viewport happened to be sitting, and `!3d…!4d…` is the pin
 * itself. They differ by about 270 metres of longitude here — enough to put the marker in the wrong
 * building — so these are read from `!3d22.3132798!4d87.3136668`.
 *
 * Zoom 17 rather than the schema's default 13: 13 shows the whole of Kharagpur, which does not tell
 * a visitor which building to walk to. 17 is a campus and its roads.
 */
const LOCATION = {
  addressLine1: "ABIF Building",
  addressLine2: "IIT Kharagpur",
  city: "Kharagpur",
  state: "West Bengal",
  postalCode: "721302",
  country: "India",
  mapLatitude: 22.3132798,
  mapLongitude: 87.3136668,
  mapZoom: 17
} as const;

async function main(): Promise<void> {
  const existing = await prisma.setting.findUnique({ where: { key: "contact" } });
  const current = (existing?.value ?? {}) as Record<string, unknown>;

  // Merged, not replaced: `departments`, `email` and `phone` live in this same group and are an
  // administrator's to fill in. Writing LOCATION alone would silently erase them.
  const merged = { ...current, ...LOCATION };

  // Parsed before it is stored, so a typo here fails now rather than at render time on the contact
  // page. The schema is the same one the studio form validates against.
  const parsed = contactSettingsSchema.parse(merged);

  await prisma.setting.upsert({
    where: { key: "contact" },
    create: { key: "contact", value: parsed },
    update: { value: parsed }
  });

  console.log("contact settings written:");
  console.log(`  ${parsed.addressLine1}, ${parsed.addressLine2}`);
  console.log(`  ${parsed.city}, ${parsed.state} ${parsed.postalCode}, ${parsed.country}`);
  console.log(`  pin ${parsed.mapLatitude}, ${parsed.mapLongitude} at zoom ${parsed.mapZoom}`);
  if (!parsed.email && !parsed.phone) {
    console.log("\n  note: no email or telephone is set, so /contact still says none is published.");
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
