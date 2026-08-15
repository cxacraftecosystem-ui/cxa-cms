import type { Metadata } from "next";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { siteName, siteUrl, storageConfigured } from "@/lib/env";
import { canManageStructure } from "@/lib/permissions";
import { CENTRE_TIME_ZONE } from "@/components/site/EventDateBlock";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { PageEditor, type PageSettingsValue } from "../[id]/PageEditor";

/**
 * The new-page screen.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A NEW PAGE IS THE SETTINGS FORM AND NOTHING ELSE, ON PURPOSE.
 *
 * Blocks belong to a page that exists: `PageSection.pageId` is a foreign key, and a builder with nowhere
 * to write would have to hold every block in the browser and create them in a batch afterwards — which
 * means a half-created page whenever one of those requests fails. So this screen asks for the title, the
 * address and the publication state, creates the row, and lands the reader on the builder.
 *
 * It renders the SAME component as the editor next door, in `create` mode. Two forms for one set of
 * fields is two places to add the next field to, and the one that gets forgotten is always the one
 * somebody is using.
 *
 * ⚠ THIS ROUTE EXISTS AS A STATIC SEGMENT ALONGSIDE `[id]`, and Next matches static segments first — so
 * `/studio/pages/new` can never be read as a page whose id is the word "new".
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "New page"
};

/**
 * A blank page.
 *
 * Every optional string is `""` rather than null, because a controlled input handed `undefined` or
 * `null` switches to uncontrolled and React warns; and the status is DRAFT so that nothing can be
 * created live by pressing Enter in the title field.
 */
const BLANK: PageSettingsValue = {
  title: "",
  slug: "",
  navLabel: "",
  status: "DRAFT",
  publishedAt: null,
  publishAt: null,
  unpublishAt: null,
  seoTitle: "",
  seoDescription: "",
  seoImageId: null,
  seoNoIndex: false,
  canonicalUrl: "",
  sortOrder: 0
};

export default async function StudioNewPagePage() {
  const user = await requireStudioCapability(
    canManageStructure,
    "Creating a page needs editor access or higher, because a page changes the shape of the public site. An administrator can raise yours."
  );

  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-6">
      <StudioPageHeader
        title="New page"
        back={{ href: "/studio/pages", label: "Pages" }}
        breadcrumb={[{ label: "Pages", href: "/studio/pages" }, { label: "New page" }]}
        description="Give the page a title and an address. Once it exists you can add the blocks that go on it, and publish it when it is ready."
      />

      <HelpText>
        Nothing is created until you choose &ldquo;Create this page&rdquo;. It starts as a draft, so it
        will not appear on the public site until you publish it.
      </HelpText>

      <PageEditor
        mode="create"
        pageId={null}
        initial={BLANK}
        initialSeoImage={null}
        initialSections={[]}
        isSystem={false}
        // No preview and no history: neither exists until the row does.
        previewUrl={null}
        siteOrigin={siteUrl().replace(/\/+$/, "")}
        siteName={siteName()}
        revisions={[]}
        user={user}
        storageReady={storageConfigured()}
        timeZone={CENTRE_TIME_ZONE}
      />
    </div>
  );
}
