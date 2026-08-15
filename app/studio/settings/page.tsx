import type { Metadata } from "next";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { canManageSettings } from "@/lib/permissions";
import { configurationWarnings, storageConfigured } from "@/lib/env";
import { getSettings } from "@/lib/settings/service";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { SettingsForm } from "./SettingsForm";

/**
 * Settings — the Centre's name and logos, its contact details, its social accounts, what search engines
 * see, how the homepage opens, which whole sections of the site exist, and the footer.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageSettings)` IS THE FIRST STATEMENT — administrator only, and it is the same
 * predicate the `/api/studio/settings/*` handler calls and the same one `StudioNav` hides the sidebar entry
 * with. It THROWS rather than rendering (contract §1.8). These values are read by every page of the site,
 * so the tier that may change them is the highest one.
 *
 * ⚠ `getSettings()` IS NOT THE RAW ROWS, and that difference is the reason this screen can be trusted. It
 * parses each group and, when a stored document no longer validates, PARSES EACH FIELD ON ITS OWN and keeps
 * the ones that pass — warning on the server which fields fell back (settings/service.ts). A strict parse
 * would throw and take down the whole studio; a bare `?? defaults` would silently discard six good fields
 * to punish the one that was not. What the form receives is therefore always a complete, valid document,
 * and saving it repairs the stored one.
 *
 * THE DIAGNOSTICS COME FROM `configurationWarnings()`, WHICH IS `server-only`. Its sentences are read here
 * and handed down as plain strings — importing `lib/env.ts` into a client component would be a build error,
 * and rightly so: it also holds the JWT secret. This is the panel where an administrator learns that
 * uploads are disabled, rather than learning it from an upload that fails at 90%.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Settings"
};

export default async function StudioSettingsPage() {
  await requireStudioCapability(
    canManageSettings,
    "Settings need administrator access. Ask an administrator to make the change, or to raise your access."
  );

  /**
   * ⚠ `getSettings()`, NOT `getSettingsCached()`.
   *
   * The cached reader is memoised for the request and is what the public pages use. On this screen the
   * memo would be shared with anything else in the same render that read a setting — harmless today, but
   * this is the one screen whose whole purpose is to show exactly what is stored, so it asks the database
   * directly and takes the extra query.
   */
  const settings = await getSettings();

  return (
    <div className="mx-auto w-full max-w-[64rem] space-y-6">
      <StudioPageHeader
        title="Settings"
        description="What the site calls itself, how to reach the Centre, and which parts of the website exist at all. Every one of these appears on the public site, so a change here is visible everywhere within seconds of being saved."
      />

      <SettingsForm
        settings={settings}
        diagnostics={configurationWarnings()}
        storageReady={storageConfigured()}
      />
    </div>
  );
}
