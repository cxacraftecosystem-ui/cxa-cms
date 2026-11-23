"use client";

/**
 * The page builder's three blocks that are Client Components, each loaded as its own chunk.
 *
 * The other block types are Server Components imported statically by SectionRenderer; their own
 * interactive pieces are split in components/sections/lazy-islands.tsx. These three ARE Client
 * Components, and a Server Component's dynamic import is not code-split in this build (measured), so
 * they are wrapped in this Client Component, where `next/dynamic` does split. Server rendering is untouched — `ssr`
 * stays on — so the HTML is the same; only a page that renders one of these blocks downloads its code.
 *
 * Each loader goes through `island()` so a client-side navigation can start it early
 * (components/sections/island-registry.ts).
 *
 * Each export is typed as the component it loads. `next/dynamic` would type it as `ComponentType<P>`,
 * which includes class components and would loosen the renderer map's per-block check; the `import type`
 * lines are erased at build and do not pull the modules back into the page.
 */

import dynamic from "next/dynamic";

import { island } from "@/components/sections/island-registry";

import type { ContactFormSection as ContactFormSectionComponent } from "@/components/sections/ContactFormSection";
import type { FormEmbedSection as FormEmbedSectionComponent } from "@/components/sections/FormEmbedSection";
import type { MapSection as MapSectionComponent } from "@/components/sections/MapSection";

export const ContactFormSection = dynamic(
  island("ContactFormSection", () => import("@/components/sections/ContactFormSection").then((module) => module.ContactFormSection))
) as unknown as typeof ContactFormSectionComponent;

export const FormEmbedSection = dynamic(
  island("FormEmbedSection", () => import("@/components/sections/FormEmbedSection").then((module) => module.FormEmbedSection))
) as unknown as typeof FormEmbedSectionComponent;

export const MapSection = dynamic(
  island("MapSection", () => import("@/components/sections/MapSection").then((module) => module.MapSection))
) as unknown as typeof MapSectionComponent;
