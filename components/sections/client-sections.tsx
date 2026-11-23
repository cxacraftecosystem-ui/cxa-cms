"use client";

/**
 * The page builder's three blocks that are Client Components, each loaded as its own chunk.
 *
 * components/sections/SectionRenderer.tsx loads every other renderer through `next/dynamic` from the
 * server, which code-splits the Client Components inside them. A Server Component's dynamic import of a
 * Client Component is not code-split (node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md), so
 * these three are wrapped here, in a Client Component, where it is. Server rendering is untouched — `ssr`
 * stays on — so the HTML is the same; only a page that renders one of these blocks downloads its code.
 *
 * Each export is typed as the component it loads. `next/dynamic` would type it as `ComponentType<P>`,
 * which includes class components and would loosen the renderer map's per-block check; the `import type`
 * lines are erased at build and do not pull the modules back into the page.
 */

import dynamic from "next/dynamic";

import type { ContactFormSection as ContactFormSectionComponent } from "@/components/sections/ContactFormSection";
import type { FormEmbedSection as FormEmbedSectionComponent } from "@/components/sections/FormEmbedSection";
import type { MapSection as MapSectionComponent } from "@/components/sections/MapSection";

export const ContactFormSection = dynamic(() =>
  import("@/components/sections/ContactFormSection").then((module) => module.ContactFormSection)
) as unknown as typeof ContactFormSectionComponent;

export const FormEmbedSection = dynamic(() =>
  import("@/components/sections/FormEmbedSection").then((module) => module.FormEmbedSection)
) as unknown as typeof FormEmbedSectionComponent;

export const MapSection = dynamic(() =>
  import("@/components/sections/MapSection").then((module) => module.MapSection)
) as unknown as typeof MapSectionComponent;
